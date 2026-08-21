// The Blaude gateway: an Anthropic-Messages-shaped front door over local models.
import { createServer } from 'node:http';
import { watch } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { resolveModel, RouteError } from './router.mjs';
import { anthropicToOpenAI, flattenSystem, TranslateError } from './anthropic-to-openai.mjs';
import { openAIToAnthropic, estimateTokens, newMessageId } from './openai-to-anthropic.mjs';
import { AnthropicSSEBuilder, SSEParser, serializeSSE } from './stream.mjs';
import { recordUsage, readUsage, summarize } from './usage.mjs';
import { makeLogger } from './log.mjs';
import {
  normalizePolicy, AllowanceMeter, TurnAffinity, decide, explainPolicy,
  classifyRequest, stripPurposePrefix, pct, fmt,
} from './policy.mjs';
import { escalateViaCLI } from './claude-cli.mjs';
import { cachedCapability, capabilityKey } from './capabilities.mjs';
import { syntheticSSE } from './stream.mjs';
import { fitToContext, describeFit } from './fit-context.mjs';
import { toOllamaRequest, fromOllamaResponse, fromOllamaChunk, NDJSONParser } from './ollama-backend.mjs';
import { residentContext } from './ollama-admin.mjs';

const MAX_BODY_BYTES = 256 * 1024 * 1024; // Claude Code payloads get large.

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new TranslateError('Request body too large', { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJSON(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function sendError(res, status, type, message) {
  if (res.headersSent) { res.end(); return; }
  sendJSON(res, status, { type: 'error', error: { type, message } });
}

/** Estimate prompt size so message_start carries a sane input_tokens. */
export function estimateRequestTokens(body) {
  let n = estimateTokens(flattenSystem(body.system));
  for (const m of body.messages || []) n += estimateTokens(m.content);
  for (const t of body.tools || []) n += estimateTokens(t);
  return n;
}

export function createGateway(cfg) {
  const log = makeLogger(cfg.logLevel);
  const started = Date.now();
  const counters = { requests: 0, streamed: 0, errors: 0, cloud: 0, escalated: 0 };
  // Policy is held in a mutable box so a config change can take effect in a
  // running session. Restarting the gateway to pick up `blaude mode` would drop
  // every in-flight request and break any session pointed at it.
  const state = {
    policy: normalizePolicy(cfg.policy || {}),
    meter: null,
    affinity: new TurnAffinity(),
  };
  state.meter = new AllowanceMeter({ policy: state.policy });

  function reloadConfig(reason) {
    try {
      const next = loadConfig();
      const nextPolicy = normalizePolicy(next.policy || {});
      const changed = JSON.stringify(nextPolicy) !== JSON.stringify(state.policy)
        || next.defaultModel !== cfg.defaultModel;
      if (!changed) return false;

      Object.assign(cfg, next);
      state.policy = nextPolicy;
      // A fresh meter, because limits and unit may have moved with the policy.
      state.meter = new AllowanceMeter({ policy: nextPolicy });
      log.info(
        `\x1b[36mconfig reloaded\x1b[0m (${reason}) — mode ${nextPolicy.mode}, ` +
        `local ${next.defaultModel}, floors ` +
        Object.entries(nextPolicy.floors).map(([k, v]) => `${k}=${v >= 1 ? 'local' : `${Math.round(v * 100)}%`}`).join(' '),
      );
      return true;
    } catch (err) {
      log.error(`config reload failed, keeping the previous policy: ${err.message}`);
      return false;
    }
  }

  // Watching the file means `blaude mode` / `blaude use` apply to a live session.
  let watcher = null;
  if (cfg.configSource && cfg.configSource !== '(defaults)') {
    try {
      let debounce = null;
      watcher = watch(cfg.configSource, () => {
        clearTimeout(debounce);
        debounce = setTimeout(() => reloadConfig('file changed'), 150);
      });
      watcher.unref?.();
    } catch { /* watching is a convenience, not a requirement */ }
  }

  const ctx = { cfg, log, counters, state };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    try {
      if (req.method === 'GET' && (path === '/health' || path === '/')) {
        return sendJSON(res, 200, {
          ok: true,
          service: 'blaude',
          version: '0.1.0',
          uptimeSeconds: Math.round((Date.now() - started) / 1000),
          defaultModel: cfg.defaultModel,
          models: Object.keys(cfg.models),
          backends: Object.fromEntries(
            Object.entries(cfg.backends).map(([k, v]) => [k, { kind: v.kind, baseUrl: v.baseUrl }]),
          ),
          counters,
          configSource: cfg.configSource,
        });
      }

      if (req.method === 'GET' && path === '/v1/models') {
        const data = Object.entries(cfg.models).map(([name, m]) => ({
          type: 'model',
          id: name,
          display_name: `Blaude ${name} (${m.backend}:${m.model})`,
          created_at: new Date(started).toISOString(),
        }));
        return sendJSON(res, 200, { data, has_more: false, first_id: data[0]?.id ?? null });
      }

      if (req.method === 'GET' && path === '/blaude/status') {
        if (url.searchParams.get('reload')) reloadConfig('requested');
        await state.meter.refresh();
        return sendJSON(res, 200, {
          mode: state.policy.mode,
          cloudTransport: state.policy.cloudTransport,
          source: state.policy.source,
          windows: state.meter.windows,
          binding: state.meter.tightest(),
          uncalibrated: state.meter.uncalibrated,
          routing: explainPolicy(state.policy, state.meter),
          defaultModel: cfg.defaultModel,
          counters,
        });
      }

      if (req.method === 'GET' && path === '/blaude/stats') {
        const entries = await readUsage(cfg);
        return sendJSON(res, 200, summarize(entries, cfg.pricing || {}));
      }

      if (req.method === 'POST' && path === '/v1/messages/count_tokens') {
        const body = JSON.parse(await readBody(req));
        return sendJSON(res, 200, { input_tokens: estimateRequestTokens(body) });
      }

      if (req.method === 'POST' && path === '/v1/messages') {
        const raw = await readBody(req);
        let body;
        try { body = JSON.parse(raw); } catch { throw new TranslateError('Request body is not valid JSON'); }
        return await handleMessages({ ...ctx, policy: state.policy, meter: state.meter, affinity: state.affinity, req, res, body, raw });
      }

      return sendError(res, 404, 'not_found_error', `Blaude has no route for ${req.method} ${path}`);
    } catch (err) {
      counters.errors++;
      const status = err.status || 500;
      log.error(`${req.method} ${path} -> ${status}: ${err.message}`);
      return sendError(res, status, err.type || 'api_error', err.message || 'Internal error');
    }
  });

  server.keepAliveTimeout = 120_000;
  server.blaude = { state, counters, cfg, reloadConfig };
  server.on('close', () => watcher?.close?.());
  server.headersTimeout = 130_000;
  server.requestTimeout = 0; // long local generations must not be cut off
  return { server, log, counters };
}

function explicitFrom(model) {
  const m = String(model ?? '');
  if (/^(local|blaude)\//i.test(m)) return 'local';
  if (/^(cloud|anthropic)\//i.test(m)) return 'cloud';
  return null;
}

async function handleMessages({ cfg, log, counters, policy, meter, affinity, req, res, body, raw }) {
  counters.requests++;
  const t0 = performance.now();

  // 1. Does this request deserve Claude?
  const explicit = explicitFrom(body.model);
  await meter.refresh().catch((e) => log.warn(`allowance refresh failed: ${e.message}`));

  const localPeek = resolveModel(cfg, stripPurposePrefix(body.model));
  const caps = cachedCapability(capabilityKey(localPeek.backendName, localPeek.model)) || {};
  const decision = decide({
    policy, meter, body, requestedModel: body.model, explicit, affinity,
    localCapabilities: { tools: caps.tools ?? null },
  });

  log.debug(`purpose=${decision.purpose} -> ${decision.destination} (${decision.reason})`);

  // The handoff moment is worth calling out — it is the whole point of Blaude.
  if (decision.handoff === 'claude->local') {
    log.info(`\x1b[33m⇢ handoff\x1b[0m Claude -> ${cfg.defaultModel}: ${decision.reason}`);
  } else if (decision.handoff === 'hard-stop') {
    log.warn(`\x1b[33m⇢ handoff\x1b[0m mid-turn hard stop: ${decision.reason}`);
  }

  if (decision.destination === 'cloud') {
    counters.cloud++;
    if (policy.cloudTransport === 'cli') {
      counters.escalated++;
      return escalateThroughCLI({ cfg, log, policy, meter, req, res, body, decision, t0 });
    }
    const cloudRoute = resolveModel(cfg, `cloud/${decision.model}`);
    return passthroughToAnthropic({ cfg, log, req, res, body, raw, route: cloudRoute, t0, decision, meter });
  }

  // 2. Local it is. A purpose-specific local model overrides the route table.
  const route = decision.model && cfg.models[decision.model]
    ? resolveModel(cfg, decision.model)
    : localPeek;

  if (route.passthrough) {
    counters.cloud++;
    return passthroughToAnthropic({ cfg, log, req, res, body, raw, route, t0, decision, meter });
  }

  if (Array.isArray(body.tools) && body.tools.length && caps.tools === false) {
    log.warn(
      `${route.backendName}/${route.model} showed no tool-calling support when probed — ` +
      `relying on text tool-call parsing. Set policy.capabilityRouting.toolsRequireClaude ` +
      `to send these to Claude instead.`,
    );
  }

  let localBody = decision.handoff && policy.handoff?.announce
    ? withHandoffNote(body, decision)
    : body;

  // Strip tools that cannot work without Anthropic-side auth, so the model says
  // "I cannot search" instead of inventing an answer around an empty result.
  const dropped = dropUnusableTools(localBody, cfg.localToolPolicy);
  if (dropped.names.length) {
    localBody = dropped.body;
    log.debug(`withheld ${dropped.names.join(', ')} from the local model (no Anthropic auth in a local session)`);
  }

  // Fit the prompt to what the backend will really accept.
  //
  // Preference order: what Ollama says it actually allocated for the loaded
  // model (exact, and it moves with memory pressure), then what `blaude doctor`
  // measured, then what you declared. The server truncates silently otherwise.
  const allocated = route.backend.kind === 'ollama'
    ? await residentContext(route.backend.baseUrl, route.model).catch(() => null)
    : null;
  const contextLimit = allocated
    || Math.min(...[route.maxContext, caps.effectiveContext].filter(Boolean))
    || null;
  if (allocated && route.maxContext && allocated < route.maxContext * 0.8) {
    log.warn(
      `${route.model} is loaded with only ${allocated} tokens of context (you configured ` +
      `${route.maxContext}). Ollama shrinks context to fit memory — unload other models ` +
      `(\`ollama stop <model>\`) or point blaude-small at the same model to get it back.`,
    );
  }
  if (cfg.contextFit?.enabled !== false && contextLimit) {
    const { body: fitted, report } = fitToContext(localBody, {
      limit: contextLimit,
      reserveOutput: cfg.contextFit?.reserveOutput ?? Math.min(4096, body.max_tokens || 4096),
      maxToolResultChars: cfg.contextFit?.maxToolResultChars ?? 4000,
    });
    if (report.fitted) {
      localBody = fitted;
      log.warn(`context fit for ${route.target}: ${describeFit(report)}`);
    }
  }

  const openaiReq = anthropicToOpenAI(localBody, route, cfg);
  const inputEstimate = estimateRequestTokens(localBody);

  const isOllama = route.backend.kind === 'ollama';
  const upstreamUrl = isOllama
    ? `${route.backend.baseUrl.replace(/\/+$/, '')}/api/chat`
    : `${route.backend.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const upstreamBody = isOllama
    ? toOllamaRequest(openaiReq, {
        // num_ctx is clamped by the daemon's own OLLAMA_CONTEXT_LENGTH, so this
        // asks for what we want and `blaude ollama context` raises the ceiling.
        numCtx: route.maxContext || null,
        think: cfg.thinking === 'text',
      })
    : openaiReq;
  const controller = new AbortController();
  const onClose = () => controller.abort();
  req.on('close', onClose);

  let upstream;
  try {
    upstream = await fetch(upstreamUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(route.backend.apiKey ? { authorization: `Bearer ${route.backend.apiKey}` } : {}),
      },
      body: JSON.stringify(upstreamBody),
      signal: controller.signal,
    });
  } catch (err) {
    req.off('close', onClose);
    counters.errors++;
    if (controller.signal.aborted) return res.end();
    const hint =
      `Cannot reach the ${route.backendName} backend at ${route.backend.baseUrl}. ` +
      `Start it (e.g. \`ollama serve\`, or \`blaude mlx\` for MLX) then retry.`;
    log.error(hint, err.message);
    recordUsage(cfg, usageEntry({ route, body, decision, ms: performance.now() - t0, error: 'backend_unreachable' }));
    return sendError(res, 502, 'api_error', hint);
  }

  if (!upstream.ok) {
    req.off('close', onClose);
    counters.errors++;
    const detail = (await upstream.text().catch(() => '')).slice(0, 2000);
    log.error(`${route.backendName} returned ${upstream.status}: ${detail}`);
    recordUsage(cfg, usageEntry({ route, body, decision, ms: performance.now() - t0, error: `upstream_${upstream.status}` }));
    return sendError(res, upstream.status === 404 ? 502 : upstream.status, 'api_error',
      `${route.backendName} backend error (${upstream.status}) for model "${route.model}": ${detail}`);
  }

  if (!openaiReq.stream) {
    req.off('close', onClose);
    const rawBody = await upstream.json();
    const completion = isOllama ? fromOllamaResponse(rawBody) : rawBody;
    detectTruncation({ log, route, completion, inputEstimate, contextLimit });
    const anthropic = openAIToAnthropic(completion, {
      requestedModel: body.model,
      thinking: cfg.thinking,
      textToolCalls: cfg.textToolCalls,
      inputTokenEstimate: inputEstimate,
    });
    const ms = performance.now() - t0;
    logCompletion(log, route, anthropic.usage, ms, false);
    recordUsage(cfg, usageEntry({
      route, body, decision, ms,
      inputTokens: anthropic.usage.input_tokens,
      outputTokens: anthropic.usage.output_tokens,
      stopReason: anthropic.stop_reason,
    }));
    return sendJSON(res, 200, anthropic);
  }

  counters.streamed++;
  return relayStream({ cfg, log, counters, req, res, body, route, upstream, inputEstimate, t0, onClose, decision, isOllama, contextLimit });
}

async function relayStream({ cfg, log, counters, req, res, body, route, upstream, inputEstimate, t0, onClose, decision, isOllama = false, contextLimit = null }) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-blaude-route': `${route.backendName}/${route.model}`,
  });

  const builder = new AnthropicSSEBuilder({
    requestedModel: body.model,
    messageId: newMessageId(),
    inputTokens: inputEstimate,
    thinking: cfg.thinking,
    textToolCalls: cfg.textToolCalls,
  });
  const parser = isOllama ? new NDJSONParser() : new SSEParser();
  const write = (event) => { if (!res.writableEnded) res.write(serializeSSE(event)); };

  let firstTokenMs = null;
  try {
    const decoder = new TextDecoder();
    for await (const chunk of upstream.body) {
      const events = [];
      for (const payload of parser.push(decoder.decode(chunk, { stream: true }))) {
        if (payload === '[DONE]') continue;
        if (payload.error) throw new Error(payload.error.message || JSON.stringify(payload.error));
        // Ollama's native stream is NDJSON in its own shape; normalise it.
        const normalised = isOllama ? fromOllamaChunk(payload) : [payload];
        for (const p of normalised) events.push(...builder.pushChunk(p));
      }
      for (const e of events) {
        if (firstTokenMs === null && e.event === 'content_block_delta') firstTokenMs = performance.now() - t0;
        write(e);
      }
    }
    for (const e of builder.finish()) write(e);
    res.end();
  } catch (err) {
    counters.errors++;
    if (!req.destroyed && !res.writableEnded) {
      // Mid-stream failures must still terminate the Anthropic event sequence.
      log.error(`stream from ${route.backendName} failed: ${err.message}`);
      write({ event: 'error', data: { type: 'error', error: { type: 'api_error', message: err.message } } });
      for (const e of builder.finish()) write(e);
      res.end();
    }
  } finally {
    req.off('close', onClose);
    const ms = performance.now() - t0;
    const s = builder.stats();
    detectTruncation({
      log, route, inputEstimate, contextLimit,
      completion: { usage: { prompt_tokens: s.inputTokens } },
    });
    logCompletion(log, route, { input_tokens: s.inputTokens, output_tokens: s.outputTokens }, ms, true, firstTokenMs);
    recordUsage(cfg, usageEntry({
      route, body, decision, ms,
      inputTokens: s.inputTokens,
      outputTokens: s.outputTokens,
      stopReason: s.stopReason,
      stream: true,
      ttftMs: firstTokenMs,
    }));
  }
}

/** Cloud escalation: forward the untouched Anthropic request upstream. */
async function passthroughToAnthropic({ cfg, log, req, res, raw, route, t0, body, decision = null, meter = null }) {
  const url = `${route.backend.baseUrl.replace(/\/+$/, '')}/v1/messages`;
  const controller = new AbortController();
  req.on('close', () => controller.abort());

  // The requested model may have carried a `cloud/` prefix; send the real id.
  let forwardBody = raw;
  if (body.model !== route.model) forwardBody = JSON.stringify({ ...body, model: route.model });

  log.info(`\x1b[35mcloud\x1b[0m ${route.model} (${route.via}) — this request is billed`);

  const upstream = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': route.backend.apiKey,
      'anthropic-version': req.headers['anthropic-version'] || '2023-06-01',
      ...(req.headers['anthropic-beta'] ? { 'anthropic-beta': req.headers['anthropic-beta'] } : {}),
    },
    body: forwardBody,
    signal: controller.signal,
  });

  res.writeHead(upstream.status, {
    'content-type': upstream.headers.get('content-type') || 'application/json',
    'x-blaude-route': `anthropic/${route.model}`,
  });
  if (upstream.body) {
    for await (const chunk of upstream.body) if (!res.writableEnded) res.write(chunk);
  }
  res.end();
  const entry = usageEntry({ route, body, decision, ms: performance.now() - t0, cloud: true });
  recordUsage(cfg, entry);
  meter?.record(entry);
}

/**
 * Cloud escalation over the official CLI — your subscription, not API credits.
 * The CLI answers in one piece, so a streaming caller gets a synthesized stream.
 */
async function escalateThroughCLI({ cfg, log, policy, meter, req, res, body, decision, t0 }) {
  const model = decision.model || 'sonnet';
  log.info(
    `\x1b[35mclaude\x1b[0m ${model} via CLI · purpose=${decision.purpose} · ${decision.reason}`,
  );

  let result;
  try {
    result = await escalateViaCLI(body, {
      model,
      shape: Array.isArray(body.tools) && body.tools.length ? 'relay' : 'oracle',
      cwd: cfg.escalationCwd || process.cwd(),
      timeoutMs: cfg.escalationTimeoutMs || 300_000,
    });
  } catch (err) {
    log.error(`escalation to Claude failed: ${err.message}`);
    if (policy.onExhausted === 'error') {
      return sendError(res, 502, 'api_error', `Claude escalation failed: ${err.message}`);
    }
    // Falling back locally beats failing the request outright.
    log.warn('falling back to the local model for this request');
    const route = resolveModel(cfg, stripPurposePrefix(body.model));
    const openaiReq = anthropicToOpenAI(body, route, cfg);
    return serveLocalFallback({ cfg, log, req, res, body, route, openaiReq, t0, decision });
  }

  const ms = performance.now() - t0;
  const msg = result.message;
  const entry = usageEntry({
    route: { target: `claude-cli:${model}`, backendName: 'claude-cli', model, via: 'policy', passthrough: true },
    body, decision, ms,
    inputTokens: msg.usage.input_tokens,
    outputTokens: msg.usage.output_tokens,
    stopReason: msg.stop_reason,
    cloud: true,
    stream: Boolean(body.stream),
  });
  entry.costUsd = result.costUsd;
  recordUsage(cfg, entry);
  meter?.record(entry);
  log.info(
    `\x1b[35mclaude\x1b[0m ${model} ${msg.usage.input_tokens} in / ${msg.usage.output_tokens} out · ` +
    `${(ms / 1000).toFixed(1)}s${result.costUsd != null ? ` · CLI reports $${result.costUsd.toFixed(4)}` : ''}`,
  );

  if (!body.stream) return sendJSON(res, 200, msg);

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-blaude-route': `claude-cli/${model}`,
  });
  for (const event of syntheticSSE(msg)) res.write(serializeSSE(event));
  return res.end();
}

/** Used when an escalation fails and we would rather answer than error. */
async function serveLocalFallback({ cfg, log, req, res, body, route, openaiReq, t0, decision }) {
  const upstream = await fetch(`${route.backend.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(route.backend.apiKey ? { authorization: `Bearer ${route.backend.apiKey}` } : {}) },
    body: JSON.stringify({ ...openaiReq, stream: false }),
  }).catch((e) => { throw new TranslateError(`local fallback failed too: ${e.message}`, { status: 502 }); });

  if (!upstream.ok) {
    return sendError(res, 502, 'api_error', `local fallback returned ${upstream.status}`);
  }
  const completion = await upstream.json();
  const msg = openAIToAnthropic(completion, {
    requestedModel: body.model, thinking: cfg.thinking, textToolCalls: cfg.textToolCalls,
    inputTokenEstimate: estimateRequestTokens(body),
  });
  recordUsage(cfg, usageEntry({
    route, body, decision, ms: performance.now() - t0,
    inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens, stopReason: msg.stop_reason,
  }));
  if (!body.stream) return sendJSON(res, 200, msg);
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const event of syntheticSSE(msg)) res.write(serializeSSE(event));
  return res.end();
}

/**
 * Remove tools a local session cannot actually execute, and say so in the system
 * prompt. See config.localToolPolicy for why WebSearch is the default case.
 */
function dropUnusableTools(body, localToolPolicy) {
  const drop = localToolPolicy?.drop;
  if (!Array.isArray(drop) || !drop.length || !Array.isArray(body.tools)) return { body, names: [] };

  const names = body.tools.filter((t) => drop.includes(t?.name)).map((t) => t.name);
  if (!names.length) return { body, names: [] };

  const tools = body.tools.filter((t) => !drop.includes(t?.name));
  let system = body.system;
  if (localToolPolicy.note !== false) {
    const note =
      `Note: ${names.join(' and ')} ${names.length > 1 ? 'are' : 'is'} not available in this session. ` +
      `If a question needs information you do not have, say so plainly — do not answer from memory ` +
      `and do not invent sources or citations.`;
    system = typeof system === 'string'
      ? `${system}\n\n${note}`
      : [...(Array.isArray(system) ? system : []), { type: 'text', text: note }];
  }
  return { body: { ...body, tools, system }, names };
}

/**
 * A one-line note so the local model does not act baffled by a conversation it
 * did not start. Costs nothing on Claude's side — Claude is simply not called.
 */
function withHandoffNote(body, decision) {
  const note =
    'Note: earlier turns in this conversation were answered by Claude. You are ' +
    'now serving this session locally because the Claude allowance ran low. ' +
    'Continue the work as-is; do not restart or re-plan from scratch.';
  const system = typeof body.system === 'string'
    ? `${body.system}\n\n${note}`
    : [...(Array.isArray(body.system) ? body.system : []), { type: 'text', text: note }];
  return { ...body, system };
}

/**
 * Did the backend quietly drop part of our prompt?
 *
 * Local servers accept an oversized prompt and truncate the front of it rather
 * than erroring. The tell is the token count they report back: materially fewer
 * tokens than we sent means the rest was discarded, taking the system prompt and
 * tool definitions with it.
 */
function detectTruncation({ log, route, completion, inputEstimate, contextLimit }) {
  const reported = completion?.usage?.prompt_tokens;
  if (!reported || !inputEstimate) return null;
  // Estimates are approximate, so only flag a substantial shortfall.
  const shortfall = inputEstimate - reported;
  if (shortfall < Math.max(1500, inputEstimate * 0.15)) return null;

  const trip = {
    sent: inputEstimate,
    accepted: reported,
    dropped: shortfall,
    backend: route.backendName,
    model: route.model,
    contextLimit,
  };
  log.warn(
    `\x1b[31mcontext cap tripped\x1b[0m ${route.backendName}/${route.model}: sent ~${inputEstimate} tok, ` +
    `server accepted ${reported} — roughly ${shortfall} tokens were dropped, front of the prompt first. ` +
    (route.backendName === 'ollama'
      ? `Raise it with \x1b[36mblaude ollama context ${Math.ceil((inputEstimate * 1.5) / 1024) * 1024}\x1b[0m`
      : `Raise the backend's context length.`),
  );
  return trip;
}

function usageEntry({ route, body, decision = null, ms, inputTokens = 0, outputTokens = 0, stopReason = null, stream = false, cloud = false, error = null, ttftMs = null }) {
  return {
    ts: new Date().toISOString(),
    requestedModel: body?.model ?? null,
    handoff: decision?.handoff ?? null,
    contextTrip: null,
    sticky: Boolean(decision?.sticky),
    target: route.target,
    backend: route.backendName,
    upstreamModel: route.model,
    via: route.via,
    purpose: decision?.purpose ?? null,
    decision: decision?.reason ?? null,
    inputTokens,
    outputTokens,
    stopReason,
    stream,
    cloud: cloud || route.passthrough,
    ms: Math.round(ms),
    ttftMs: ttftMs == null ? null : Math.round(ttftMs),
    error,
  };
}

function logCompletion(log, route, usage, ms, streamed, ttftMs) {
  const secs = ms / 1000;
  const tps = usage.output_tokens && secs > 0 ? (usage.output_tokens / secs).toFixed(1) : '—';
  const ttft = ttftMs == null ? '' : ` ttft ${(ttftMs / 1000).toFixed(2)}s`;
  log.info(
    `\x1b[32mlocal\x1b[0m ${route.backendName}/${route.model} ` +
    `${usage.input_tokens} in / ${usage.output_tokens} out · ${tps} tok/s · ${secs.toFixed(1)}s${ttft}` +
    `${streamed ? ' · stream' : ''}`,
  );
}

export function startGateway(cfg) {
  const { server, log } = createGateway(cfg);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, cfg.host, async () => {
      const { policy, meter } = server.blaude.state;
      await meter.refresh().catch(() => {});
      const tight = meter.tightest();
      log.plain('');
      log.plain(`  \x1b[1mBlaude\x1b[0m gateway on \x1b[36mhttp://${cfg.host}:${cfg.port}\x1b[0m`);
      log.plain(`  local model    ${cfg.defaultModel} -> ${cfg.models[cfg.defaultModel].backend}/${cfg.models[cfg.defaultModel].model}`);
      log.plain(`  mode           ${policy.mode}  (cloud via ${policy.cloudTransport === 'cli' ? 'claude CLI / subscription' : 'Anthropic API / metered'})`);
      log.plain(tight
        ? `  allowance      ${pct(tight.fractionRemaining)} of ${tight.name} left (${fmt(tight.spent)}/${fmt(tight.amount)} ${policy.unit})`
        : `  allowance      not calibrated — run \x1b[90mblaude calibrate\x1b[0m to enable Claude routing`);
      log.plain(`  config         ${cfg.configSource}`);
      log.plain('');
      resolve({ server, log });
    });
  });
}
