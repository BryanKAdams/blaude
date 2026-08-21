// Probes what a local backend can actually do, so policy can route around gaps.
//
// The one that matters for a coding agent is tool calling: a model served
// without working function-call support will happily narrate a tool call in
// prose and never actually invoke it. Blaude either parses that out of the text
// (textToolCalls) or sends such requests to Claude (capabilityRouting).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { BLAUDE_HOME, ensureHome } from './config.mjs';

const CACHE_FILE = () => join(BLAUDE_HOME, 'capabilities.json');
const CACHE_TTL_MS = 7 * 24 * 3600_000;

const PROBE_TOOL = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get the current weather for a city.',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string', description: 'City name' } },
      required: ['city'],
    },
  },
};

/**
 * @returns {Promise<{reachable:boolean, tools:boolean|null, nativeToolCalls:boolean,
 *                    textToolCalls:boolean, ms:number, error?:string, sample?:string}>}
 */
export async function probeBackend({ baseUrl, apiKey, model, kind = 'openai', timeoutMs = 60_000 }) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const native = kind === 'ollama';
    const url = native
      ? `${baseUrl.replace(/\/+$/, '')}/api/chat`
      : `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const payload = native
      ? {
          model,
          messages: [{ role: 'user', content: 'What is the weather in Paris? Use the tool.' }],
          tools: [PROBE_TOOL],
          stream: false,
          think: false,
          options: { num_predict: 256 },
        }
      : {
          model,
          messages: [{ role: 'user', content: 'What is the weather in Paris? Use the tool.' }],
          tools: [PROBE_TOOL],
          tool_choice: 'auto',
          max_tokens: 256,
          stream: false,
        };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      return { reachable: true, tools: false, nativeToolCalls: false, textToolCalls: false, ms: Date.now() - started, error: `HTTP ${res.status}: ${detail}` };
    }
    const body = await res.json();
    const msg = (kind === 'ollama' ? body?.message : body?.choices?.[0]?.message) || {};
    const hasNativeToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
    const text = typeof msg.content === 'string' ? msg.content : '';
    const inText = /<tool_call>|<function_call>|"name"\s*:\s*"get_weather"/.test(text);
    return {
      reachable: true,
      tools: hasNativeToolCalls || inText,
      nativeToolCalls: hasNativeToolCalls,
      textToolCalls: !hasNativeToolCalls && inText,
      ms: Date.now() - started,
      sample: text.slice(0, 200) || undefined,
    };
  } catch (err) {
    return {
      reachable: false,
      tools: null,
      nativeToolCalls: false,
      textToolCalls: false,
      ms: Date.now() - started,
      error: controller.signal.aborted ? `no response in ${Math.round(timeoutMs / 1000)}s` : err.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

export function loadCapabilityCache() {
  try {
    if (!existsSync(CACHE_FILE())) return {};
    return JSON.parse(readFileSync(CACHE_FILE(), 'utf8'));
  } catch { return {}; }
}

export function saveCapability(key, value) {
  try {
    ensureHome();
    const cache = loadCapabilityCache();
    cache[key] = { ...value, checkedAt: new Date().toISOString() };
    writeFileSync(CACHE_FILE(), JSON.stringify(cache, null, 2));
  } catch { /* cache is an optimisation, not a requirement */ }
}

export function cachedCapability(key) {
  const entry = loadCapabilityCache()[key];
  if (!entry) return null;
  const age = Date.now() - Date.parse(entry.checkedAt || 0);
  if (Number.isNaN(age) || age > CACHE_TTL_MS) return null;
  return entry;
}

export const capabilityKey = (backendName, model) => `${backendName}/${model}`;

/**
 * Measures the effective context window by planting a needle at the very start
 * of a large prompt and asking for it back.
 *
 * This matters more than it sounds: Ollama defaults to a modest context and
 * silently DROPS the overflow rather than erroring, and Claude Code routinely
 * sends 20k-40k token system prompts. A truncated prompt loses the system prompt
 * and tool definitions first, so the agent degrades in ways that look like a
 * dumb model rather than a misconfigured server.
 */
export async function probeContext({ baseUrl, apiKey, model, kind = 'openai', numCtx = null, targetTokens = 24_000, timeoutMs = 300_000 }) {
  const needle = 'ZEBRA9137';
  // ~4 chars/token of low-compressibility filler.
  const filler = [];
  let seed = 12345;
  for (let i = 0; i < targetTokens; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    filler.push((seed % 100000).toString(36));
  }
  const prompt = `NEEDLE_TOKEN=${needle}. ` + filler.join(' ');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const native = kind === 'ollama';
    const messages = [
      { role: 'system', content: prompt },
      { role: 'user', content: 'Repeat the value of NEEDLE_TOKEN exactly. If it is not in your context, reply MISSING.' },
    ];
    const res = await fetch(
      native ? `${baseUrl.replace(/\/+$/, '')}/api/chat` : `${baseUrl.replace(/\/+$/, '')}/chat/completions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify(native
          ? { model, messages, stream: false, think: false, options: { num_predict: 256, ...(numCtx ? { num_ctx: numCtx } : {}) } }
          : { model, messages, max_tokens: 512, stream: false }),
        signal: controller.signal,
      },
    );
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const body = await res.json();
    const text = (native ? body?.message?.content : body?.choices?.[0]?.message?.content) ?? '';
    const reported = (native ? body?.prompt_eval_count : body?.usage?.prompt_tokens) ?? null;
    const survived = text.includes(needle);
    return {
      ok: true,
      survived,
      reportedPromptTokens: reported,
      sentApproxTokens: targetTokens,
      truncated: !survived,
      // When the server truncates, the token count it reports IS its ceiling.
      effectiveContext: survived ? null : reported,
    };
  } catch (err) {
    return { ok: false, error: controller.signal.aborted ? `timed out after ${Math.round(timeoutMs / 1000)}s` : err.message };
  } finally {
    clearTimeout(timer);
  }
}
