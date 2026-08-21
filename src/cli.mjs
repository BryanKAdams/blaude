// The `blaude` command line.
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync, existsSync, readFileSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, BLAUDE_HOME, ensureHome, DEFAULTS } from './config.mjs';
import { startGateway } from './server.mjs';
import {
  normalizePolicy, AllowanceMeter, decide, explainPolicy, MODES, MODE_ALIASES,
  resolveModeName, PURPOSES, pct, fmt, NEVER, PERIOD_MS,
} from './policy.mjs';
import {
  claudeUsageReport, readClaudeEvents, peakWindow, DEFAULT_WEIGHTS,
  findLimitEvents, groupLimitIncidents, allotmentFromIncidents, totalsInWindow, weighTokens,
} from './claude-usage.mjs';
import { readUsageCommand, readUsageCached, writeUsageCache } from './usage-command.mjs';
import { probeBackend, probeContext, saveCapability, capabilityKey, cachedCapability } from './capabilities.mjs';
import { resolveModel } from './router.mjs';
import { readUsage, summarize } from './usage.mjs';
import { escalateViaCLI, runClaudeCLI } from './claude-cli.mjs';
import { simulate, loadHistory } from './simulate.mjs';
import { detectOllama, loadedContexts, planContextChange, applyStep, waitForOllama } from './ollama-admin.mjs';
import { listSessions, digestSession, appendNote, readNotes } from './handoff.mjs';

const C = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[90m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  magenta: (s) => `\x1b[35m${s}\x1b[0m`,
};

const out = (...a) => console.log(...a);
/**
 * Human-facing chrome that must never pollute stdout.
 *
 * `blaude -p --output-format json` is a data pipeline: anything printed to
 * stdout ends up in the caller's JSON. The launcher banner belongs on stderr,
 * where a person still sees it and a script does not.
 */
const note = (...a) => console.error(...a);
const CONFIG_FILE = () => join(BLAUDE_HOME, 'config.json');

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      flags[k] = v ?? (argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[++i] : true);
    } else positional.push(a);
  }
  return { flags, positional };
}

async function gatewayHealth(cfg, timeoutMs = 1200) {
  try {
    const res = await fetch(`http://${cfg.host}:${cfg.port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

async function ensureGateway(cfg, { quiet = false } = {}) {
  const existing = await gatewayHealth(cfg);
  if (existing) return { started: false, health: existing };

  ensureHome();
  const logPath = join(BLAUDE_HOME, 'gateway.log');
  const fd = openSync(logPath, 'a');
  const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'bin', 'blaude.mjs'), 'serve'], {
    detached: true,
    stdio: ['ignore', fd, fd],
    env: process.env,
  });
  child.unref();

  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const health = await gatewayHealth(cfg);
    if (health) {
      if (!quiet) note(C.dim(`  gateway started (pid ${child.pid}, log ${logPath})`));
      return { started: true, health };
    }
  }
  throw new Error(`gateway did not come up on ${cfg.host}:${cfg.port} — see ${logPath}`);
}

function writeConfigPatch(patch) {
  ensureHome();
  const file = CONFIG_FILE();
  const current = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const merged = deepAssign(current, patch);
  writeFileSync(file, JSON.stringify(merged, null, 2) + '\n');
  return file;
}

function deepAssign(target, patch) {
  const out = { ...target };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object' && out[k] !== null && !Array.isArray(out[k])
      ? deepAssign(out[k], v)
      : v;
  }
  return out;
}

function bar(fraction, width = 24) {
  if (fraction == null) return C.dim('·'.repeat(width));
  const used = Math.min(width, Math.max(0, Math.round((1 - fraction) * width)));
  const color = fraction > 0.5 ? C.green : fraction > 0.2 ? C.yellow : C.red;
  return color('█'.repeat(used)) + C.dim('░'.repeat(width - used));
}

/**
 * Extra CLI arguments for a local session, trimming what the local model cannot
 * use but would otherwise pay for on every single request.
 */
export function localSessionArgs(cfg) {
  const args = [];
  if (cfg.localSession?.disableMcp !== false) {
    args.push('--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}');
  }
  // Push auto-compact beyond reach on a small local window, so Claude Code stops
  // compacting in a loop and lets the context fitter do the trimming.
  if (needsCompactionGuard(cfg) && cfg.localSession?.autocompactGuard !== false) {
    args.push('--autocompact', '1000000');
  }
  if (cfg.localSession?.disableBundledSkills) {
    args.push('--settings', JSON.stringify({ disableBundledSkills: true }));
  }
  return args;
}

/**
 * Environment for a Claude Code session served by the gateway.
 *
 * Deliberately sets NO credential. Claude Code does not need one when
 * ANTHROPIC_BASE_URL points at Blaude (verified: a local session works with the
 * key entirely absent), and setting a dummy one is actively harmful — it makes
 * Claude Code prompt about a "detected API key", and it disables your claude.ai
 * connectors because an API key takes precedence over your claude.ai login.
 *
 * Any inherited real key is removed too: it would have no effect on routing
 * (requests go to the gateway either way) but would trigger the same prompt. The
 * gateway process keeps its own environment, so `cloudTransport: "api"` still
 * finds ANTHROPIC_API_KEY if you configured it.
 */
export function localSessionEnv(cfg, { force = false } = {}) {
  // Declaring a small window backfires. Claude Code's own base prompt is ~26-28k
  // tokens, so telling it the window is 40k leaves ~12k of working room and
  // auto-compact thrashes: compact, refill within three turns, compact again.
  // Measured: a task that Claude finished in 8s never completed at all.
  //
  // So the window is declared only when it is roomy enough for compaction to be
  // meaningful. Below that, auto-compact is pushed out of the way and Blaude's
  // context fitter trims each request instead — it drops the oldest tool output
  // first, which degrades far more gracefully than a compaction loop.
  const model = cfg.models[cfg.defaultModel];
  const maxContext = model?.maxContext || null;
  const ROOMY = 64_000;
  const window = maxContext && maxContext >= ROOMY ? maxContext : null;

  return {
    ANTHROPIC_BASE_URL: `http://${cfg.host}:${cfg.port}`,
    ANTHROPIC_API_KEY: undefined,
    ANTHROPIC_AUTH_TOKEN: undefined,
    // `--local` must bind the GATEWAY, not just this banner. The gateway decides
    // per request, so without the explicit prefix it can still escalate a turn to
    // Claude — which made `blaude --local` spend Claude tokens.
    ANTHROPIC_MODEL: force ? `local/${cfg.defaultModel}` : cfg.defaultModel,
    ANTHROPIC_SMALL_FAST_MODEL: force ? 'local/blaude-small' : 'blaude-small',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: force ? 'local/blaude-small' : 'blaude-small',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    ...(window ? { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(window) } : {}),
  };
}

/** True when the local window is too small for Claude Code's compaction to help. */
export function needsCompactionGuard(cfg) {
  const maxContext = cfg.models[cfg.defaultModel]?.maxContext || 0;
  return maxContext > 0 && maxContext < 64_000;
}

/**
 * Gate an out-of-band Claude call on the same floor the gateway would apply.
 *
 * `blaude audit` and `blaude search` reach Claude directly through the CLI, so
 * they bypass the gateway entirely. Without this they would spend allowance (or
 * credits) no matter what the policy says — which defeats the point of having a
 * policy. The floor for the purpose applies, and `--force` is the deliberate
 * override.
 */
async function assertAllowance(purpose, { force = false, label = purpose } = {}) {
  const cfg = loadConfig();
  const { policy, meter } = await meterFor(cfg);
  const floor = policy.floors?.[purpose] ?? NEVER;
  const tight = meter.tightestFor(policy.cloudModels?.[purpose]);

  if (force) {
    if (tight) out(C.dim(`  (--force: proceeding with ${pct(tight.fractionRemaining)} of ${tight.name} allowance left)`));
    return { policy, meter, tight };
  }
  if (!tight) return { policy, meter, tight };

  const blocked = floor >= NEVER || tight.fractionRemaining <= floor;
  if (blocked) {
    const why = floor >= NEVER
      ? `mode "${policy.mode}" keeps ${purpose} local`
      : `${pct(tight.fractionRemaining)} of your ${tight.name} allowance is left, at or below the ${pct(floor)} floor for ${purpose}`;
    throw new Error(
      `${label} would spend Claude, but ${why}.\n` +
      `  ${tight.resetsAt ? `Allowance resets ${tight.resetsAt}.\n  ` : ''}` +
      `Override with --force, or lower the floor: blaude mode ${policy.mode} --floor ${purpose}=1`,
    );
  }
  return { policy, meter, tight };
}

async function meterFor(cfg) {
  const policy = normalizePolicy(cfg.policy || {});
  const meter = new AllowanceMeter({ policy });
  await meter.refresh(true);
  return { policy, meter };
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

/**
 * Split launcher arguments into Blaude's own and everything else.
 *
 * Everything Blaude does not own must reach `claude` untouched. The generic flag
 * parser used by the subcommands is wrong here: it swallowed `--output-format`,
 * `--allowedTools` and friends, so `blaude -p --output-format json` silently ran
 * without them. That produced unparseable output and, because `--allowedTools`
 * never arrived, sessions carrying every tool including MCP — which is exactly
 * the 50k-token prompt the local model was choking on.
 */
export function splitLauncherArgs(argv) {
  const OURS = new Set(['--local', '--claude', '--cloud']);
  const ours = {};
  const passthrough = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { passthrough.push(...argv.slice(i + 1)); break; }
    if (OURS.has(a)) { ours[a.slice(2)] = true; continue; }
    passthrough.push(a);
  }
  return { ours, passthrough };
}

/** Bare `blaude`: pick the destination for this whole session, then launch it. */
export async function cmdLaunch(argv) {
  const { ours: flags, passthrough } = splitLauncherArgs(argv);
  const cfg = loadConfig();
  const { policy, meter } = await meterFor(cfg);

  // `launch: "gateway"` keeps Blaude in the path no matter what, so policy is
  // enforced on every request instead of once at launch.
  const alwaysGateway = cfg.launch === 'gateway' && !flags.claude && !flags.cloud;
  const forced = flags.local || alwaysGateway ? 'local' : flags.claude || flags.cloud ? 'cloud' : null;
  const liveDecision = decide({
    policy, meter,
    body: { messages: [{ role: 'user', content: 'session start' }] },
    requestedModel: 'main/session',
  });
  const decision = forced
    ? {
        destination: forced,
        purpose: 'main',
        model: forced === 'cloud' ? policy.cloudModels.main : null,
        reason: alwaysGateway
          ? `routing everything through Blaude (launch: gateway) — ${liveDecision.reason}`
          : `forced with --${forced}`,
      }
    : liveDecision;

  const tight = meter.tightest();
  note('');
  note(`  ${C.bold('Blaude')} ${C.dim('· ' + policy.mode)}`);
  note(`  allowance   ${tight ? `${bar(tight.fractionRemaining)} ${pct(tight.fractionRemaining)} of ${tight.name} left` : C.yellow('not calibrated — run `blaude calibrate`')}`);
  if (alwaysGateway) {
    const per = liveDecision.destination === 'cloud'
      ? C.magenta(`Claude ${liveDecision.model}`) + C.dim(' (escalated per request)')
      : C.green(`local ${cfg.defaultModel}`);
    note(`  session     ${C.cyan('routed by Blaude')} ${C.dim('— every request is policy-checked')}`);
    note(`  new turns   ${per}`);
    note(`  ${C.dim(liveDecision.reason)}`);
  } else {
    note(`  session     ${decision.destination === 'cloud'
      ? C.magenta('Claude ' + (decision.model || 'sonnet')) + C.dim(' (native, not routed)')
      : C.green('local ' + cfg.defaultModel)}`);
    note(`  ${C.dim(decision.reason)}`);
  }
  note('');

  const env = { ...process.env };
  const args = [...passthrough];

  if (decision.destination === 'cloud') {
    // Native Claude session: no interception, so prompt caching stays intact.
    delete env.ANTHROPIC_BASE_URL;
    delete env.ANTHROPIC_MODEL;
    if (decision.model) args.unshift('--model', decision.model);
  } else {
    await ensureGateway(cfg);
    Object.assign(env, localSessionEnv(cfg, { force: Boolean(flags.local) }));
    args.unshift(...localSessionArgs(cfg));
    if (flags.local) note(`  ${C.dim('--local pins every request to the local model (gateway cannot escalate)')}`);
  }

  const bin = process.env.BLAUDE_CLAUDE_BIN || 'claude';
  const child = spawn(bin, args, { stdio: 'inherit', env });
  child.on('exit', (code) => process.exit(code ?? 0));
  child.on('error', (e) => {
    console.error(C.red(`cannot launch "${bin}": ${e.message}`));
    process.exit(1);
  });
}

/**
 * Pick which local model Blaude serves from.
 *
 * Defaults to pointing BOTH roles at the same weights, because Ollama sizes
 * context to fit available memory: two resident models measured ~20k and ~16k
 * each on this machine, one resident model got the full 40,960.
 */
export async function cmdUse(argv) {
  const { flags, positional } = parseFlags(argv);
  const cfg = loadConfig();
  const wanted = positional[0];
  const backendName = flags.backend || cfg.models[cfg.defaultModel]?.backend || 'ollama';
  const backend = cfg.backends[backendName];
  if (!backend) throw new Error(`No backend "${backendName}" in your config`);

  const listInstalled = async () => {
    const res = await fetch(`${backend.baseUrl.replace(/\/+$/, '')}/api/tags`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`could not list models (HTTP ${res.status})`);
    return (await res.json()).models || [];
  };

  const describe = async (name) => {
    try {
      const res = await fetch(`${backend.baseUrl.replace(/\/+$/, '')}/api/show`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: name }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return {};
      const body = await res.json();
      const ctxKey = Object.keys(body.model_info || {}).find((k) => k.endsWith('.context_length'));
      return {
        contextLength: ctxKey ? body.model_info[ctxKey] : null,
        capabilities: body.capabilities || [],
      };
    } catch { return {}; }
  };

  let installed;
  try { installed = await listInstalled(); } catch (err) {
    throw new Error(`${err.message}. Is the ${backendName} backend running at ${backend.baseUrl}?`);
  }

  const current = cfg.models[cfg.defaultModel]?.model;

  if (!wanted) {
    out('');
    out(`  ${C.bold('Local models available')} ${C.dim(`(${backendName} at ${backend.baseUrl})`)}`);
    out('');
    for (const m of installed) {
      const marker = m.name === current ? C.green('●') : C.dim('○');
      const d = m.details || {};
      out(`  ${marker} ${C.bold(m.name.padEnd(22))} ${(m.size / 1e9).toFixed(1).padStart(5)} GB  ` +
          `${String(d.parameter_size || '?').padStart(7)}  ${C.dim(d.quantization_level || '')}`);
    }
    out('');
    out(`  current: ${C.cyan(current || '(none)')}`);
    out(`  ${C.cyan('blaude use <model>')}          switch to it (both roles, one resident model)`);
    out(`  ${C.dim('blaude use <model> --small X   give background calls a different model')}`);
    out('');
    return;
  }

  const match = installed.find((m) => m.name === wanted)
    || installed.find((m) => m.name.toLowerCase() === wanted.toLowerCase())
    || installed.find((m) => m.name.split(':')[0].toLowerCase() === wanted.toLowerCase());
  if (!match) {
    out('');
    out(`  ${C.red('✗')} "${wanted}" is not installed on ${backendName}.`);
    out(`  ${C.dim('installed: ' + installed.map((m) => m.name).join(', '))}`);
    out(`  ${C.dim(`pull it first:`)} ${C.cyan(`ollama pull ${wanted}`)}`);
    out('');
    return;
  }

  const info = await describe(match.name);

  // The model's own maximum is an upper bound, not what you will get. Ollama
  // clamps to OLLAMA_CONTEXT_LENGTH and then again to available memory, so
  // recording the model's 262k would leave the context fitter thinking it has
  // room it does not have — and the daemon would truncate silently instead.
  const daemonCap = Number(detectOllama().launchctlValue || detectOllama().envValue || 0) || null;
  const modelMax = info.contextLength || null;
  const window = Number(
    flags.context
    || Math.min(...[modelMax, daemonCap].filter(Boolean))
    || cfg.models[cfg.defaultModel]?.maxContext
    || 32768,
  );
  const small = flags.small || match.name;
  const smallInfo = small === match.name ? info : await describe(small);

  const patch = {
    models: {
      blaude: { backend: backendName, model: match.name, maxContext: window, maxOutput: 8192 },
      'blaude-small': {
        backend: backendName,
        model: small,
        maxContext: Number(flags.context || smallInfo.contextLength || window),
        maxOutput: 4096,
      },
    },
    defaultModel: 'blaude',
  };
  const file = writeConfigPatch(patch);

  out('');
  out(`  ${C.green('✓')} Blaude now serves ${C.cyan(match.name)} ${C.dim(`(${(match.size / 1e9).toFixed(1)} GB, ${match.details?.quantization_level || '?'})`)}`);
  const capNote = flags.context
    ? '(you set it)'
    : daemonCap && modelMax && daemonCap < modelMax
      ? `(daemon cap; this model can do ${modelMax.toLocaleString()})`
      : modelMax ? "(the model's own maximum)" : '(from your config)';
  out(`  context      ${window.toLocaleString()} tokens ${C.dim(capNote)}`);
  if (info.capabilities?.length) {
    const hasTools = info.capabilities.includes('tools');
    out(`  capabilities ${info.capabilities.join(', ')} ${hasTools ? '' : C.red('— no tool support, which a coding agent needs')}`);
  }
  out(`  background   ${small === match.name ? C.dim('same model (keeps one resident, so it gets the full context)') : C.cyan(small)}`);
  out(`  ${C.dim(file)}`);
  out('');
  out(`  ${C.dim('Ollama still sizes context to fit memory. Unload the old model so the new one')}`);
  out(`  ${C.dim('gets the whole window:')} ${C.cyan(`ollama stop ${current || '<old model>'}`)}`);
  out(`  ${C.dim('then verify with')} ${C.cyan('blaude doctor')}`);
  out('');
}

/** Choose whether Blaude stays in the request path for every session. */
export async function cmdRoute(argv) {
  const { positional } = parseFlags(argv);
  const cfg = loadConfig();
  const choice = positional[0];

  if (!choice) {
    out('');
    out(`  launch mode: ${C.cyan(cfg.launch)}`);
    out('');
    out(`  ${cfg.launch === 'auto' ? C.green('●') : C.dim('○')} ${C.bold('auto')}     Claude sessions run natively (no gateway in the path).`);
    out(`    ${C.dim('Fastest and cheapest while you have allowance, because prompt caching')}`);
    out(`    ${C.dim('stays intact. Blaude cannot route mid-session, so `blaude guard on`')}`);
    out(`    ${C.dim('is what stops an overrun, and the handoff is `blaude -c`.')}`);
    out('');
    out(`  ${cfg.launch === 'gateway' ? C.green('●') : C.dim('○')} ${C.bold('gateway')}  every request goes through Blaude.`);
    out(`    ${C.dim('Policy is enforced per request, the handoff happens by itself at the')}`);
    out(`    ${C.dim('next prompt, and no hook is needed. Claude-served turns pay escalation')}`);
    out(`    ${C.dim('overhead (~2.6k tokens warm, ~8.5k cold) instead of using the cache.')}`);
    out('');
    out(`  ${C.cyan('blaude route gateway')}   never leave the path`);
    out(`  ${C.cyan('blaude route auto')}      let Claude sessions run native`);
    out('');
    return;
  }

  if (!['auto', 'gateway'].includes(choice)) {
    throw new Error(`Unknown launch mode "${choice}". Use auto or gateway.`);
  }
  const file = writeConfigPatch({ launch: choice });
  out(`${C.green('✓')} launch mode set to ${C.cyan(choice)}`);
  out(C.dim(`  ${file}`));

  const policy = normalizePolicy(cfg.policy || {});
  const sendsWorkToClaude = (policy.floors?.main ?? NEVER) < NEVER;

  if (choice === 'gateway') {
    out(C.dim('  Blaude now stays in the path for every session — the guard hook is optional.'));
    if (sendsWorkToClaude) {
      out('');
      out(`  ${C.yellow('!')} Your mode (${policy.mode}) sends ordinary turns to Claude, and in this launch`);
      out(`    mode every one of those is relayed through a fresh \`claude -p\`. Measured on a`);
      out(`    small agent task: ${C.bold('~2x the Claude tokens and ~4x the wall clock')} of a native`);
      out(`    session, because the outer conversation cannot reuse the prompt cache.`);
      out(`    ${C.dim('Cheaper combinations:')}`);
      out(`      ${C.cyan('blaude route auto')} + ${C.cyan('blaude guard on')}   ${C.dim('native Claude, hook enforces the floor')}`);
      out(`      ${C.cyan('blaude mode claude-audits')}          ${C.dim('keep work local; then gateway costs nothing extra')}`);
    } else {
      out(C.dim(`  Your mode (${policy.mode}) keeps ordinary turns local, so staying in the path`));
      out(C.dim('  costs nothing extra — the relay tax only applies to Claude-served turns.'));
    }
  } else {
    out(C.dim('  Native Claude sessions are unprotected unless you run `blaude guard on`.'));
  }
}

export async function cmdServe() {
  const cfg = loadConfig();
  await startGateway(cfg);
}

export async function cmdStatus(argv) {
  const { flags } = parseFlags(argv);
  const cfg = loadConfig();
  const { policy, meter } = await meterFor(cfg);

  if (flags.json) {
    out(JSON.stringify({ mode: policy.mode, windows: meter.windows, routing: explainPolicy(policy, meter) }, null, 2));
    return;
  }

  out('');
  out(`  ${C.bold('Blaude status')}   mode ${C.cyan(policy.mode)}   cloud via ${policy.cloudTransport === 'cli' ? C.green('claude CLI (subscription)') : C.yellow('Anthropic API (metered)')}`);
  const sourceLabel = {
    'usage-command': 'exact figures from `claude /usage` (free, no tokens)',
    'claude-code': 'estimated from Claude Code transcripts',
    gateway: 'only traffic through this gateway',
  }[meter.effectiveSource || policy.source] || policy.source;
  out(`  ${C.dim(`allowance source: ${sourceLabel}`)}`);
  if (meter.lastError) out(`  ${C.yellow('!')} ${C.dim(`/usage unavailable (${meter.lastError}) — fell back to estimates`)}`);
  out('');
  out(`  ${C.bold('Allowance')}`);
  for (const [name, w] of Object.entries(meter.windows)) {
    const label = `${name} (${w.period})`.padEnd(18);
    if (w.fractionRemaining == null) {
      out(`    ${label} ${C.yellow('unknown')}  ${C.dim(`observed ${fmt(w.spent)} ${policy.unit}`)}`);
      continue;
    }
    const detail = w.source === 'usage-command'
      ? C.dim(`${w.usedPercent}% used${w.resetsAt ? ` · resets ${w.resetsAt}` : ''}`)
      : C.dim(`${fmt(w.spent)} / ${fmt(w.amount)} ${policy.unit}`);
    out(`    ${label} ${bar(w.fractionRemaining)} ${pct(w.fractionRemaining).padStart(6)} left   ${detail}`);
  }
  const tight = meter.tightest();
  if (tight) out(`    ${C.dim(`binding window: ${tight.name}`)}`);
  out('');
  out(`  ${C.bold('Routing right now')}`);
  for (const r of explainPolicy(policy, meter)) {
    const dest = r.destination === 'cloud' ? C.magenta('Claude') : C.green('local ');
    const floor = r.floor >= NEVER ? 'never' : pct(r.floor);
    out(`    ${r.purpose.padEnd(11)} ${dest} ${String(r.model).padEnd(18)} ${C.dim(`floor ${floor}`)}`);
  }
  out('');

  const health = await gatewayHealth(cfg);
  out(`  gateway     ${health ? C.green(`up on ${cfg.host}:${cfg.port}`) : C.dim('not running (starts on demand)')}`);
  const entries = await readUsage(cfg);
  if (entries.length) {
    const s = summarize(entries, cfg.pricing || {});
    out(`  served      ${C.green(fmt(s.local.inputTokens + s.local.outputTokens) + ' tokens local')} · ${C.magenta(fmt(s.cloud.inputTokens + s.cloud.outputTokens) + ' tokens Claude')} over ${s.requests} requests`);
  }
  out('');
}

/** Suggest allotments from this machine's own busiest windows. */
export async function cmdCalibrate(argv) {
  const { flags } = parseFlags(argv);
  const cfg = loadConfig();
  const policy = normalizePolicy(cfg.policy || {});
  const days = Number(flags.days || 30);

  out('');
  out(`  ${C.bold('Calibrating')} token ceilings for the transcript-based estimator and simulator.`);
  out(`  ${C.dim('Live routing does not need this: it reads exact percentages from `claude /usage`.')}`);
  out('');

  const { events } = await readClaudeEvents({ sinceMs: Date.now() - days * 86_400_000 });
  if (!events.length) {
    out(`  ${C.yellow('No Claude usage found in transcripts.')}`);
    return;
  }

  // Best evidence first: what /usage says right now, cross-referenced with the
  // tokens actually observed in the same window. If /usage says the week is 40%
  // used and we observed 120M tokens, the ceiling is about 300M.
  let live = null;
  try { live = await readUsageCommand(); } catch (err) {
    out(`  ${C.yellow('!')} could not read /usage (${err.message})`);
  }

  const suggestions = {};
  const notes = [];
  for (const [name, limit] of Object.entries(policy.limits)) {
    const span = PERIOD_MS[limit.period];
    const observed = totalsInWindow(events, span).byModel;
    const observedWeighted = Object.values(observed).reduce((n, t) => n + weighTokens(t, policy.weights), 0);
    const liveWindow = live?.windows?.[name];

    let amount = null;
    let basis = null;

    if (liveWindow && liveWindow.usedFraction > 0.05 && liveWindow.usedFraction < 1) {
      amount = Math.round(observedWeighted / liveWindow.usedFraction);
      basis = `/usage says ${liveWindow.usedPercent}% used with ${fmt(observedWeighted)} observed`;
    }

    if (!amount) {
      // Next best: moments you actually got a 429. At that instant you were at
      // the ceiling, so the preceding window's spend IS the allotment.
      const hits = await findLimitEvents({});
      const kind = name === 'session' ? 'session' : 'weekly';
      const incidents = groupLimitIncidents(hits).filter((i) => i.kind === kind);
      const anchored = incidents.length ? allotmentFromIncidents(events, incidents, span, policy.weights) : null;
      if (anchored) {
        amount = Math.round(anchored.median);
        basis = `median of ${anchored.anchors.length} real rate-limit event(s)`;
        notes.push(`    ${C.dim(`${name}: 429 anchors ${anchored.anchors.map((a) => fmt(a.spend)).join(', ')}`)}`);
      }
    }

    if (!amount) {
      const peak = peakWindow(events, span, policy.weights);
      amount = Math.ceil((peak.peak * 1.1) / 1e6) * 1e6;
      basis = `peak observed window (${fmt(peak.peak)}) — weakest evidence, likely an overestimate`;
    }

    suggestions[name] = { period: limit.period, amount };
    const liveNote = liveWindow ? `  ${C.dim(`(/usage: ${liveWindow.usedPercent}% used)`)}` : '';
    out(`  ${name.padEnd(8)} ${limit.period.padEnd(5)} ${C.cyan(fmt(amount).padStart(8))} ${policy.unit}${liveNote}`);
    out(`  ${''.padEnd(14)} ${C.dim(basis)}`);
  }
  if (notes.length) { out(''); notes.forEach((n) => out(n)); }

  out('');
  if (live?.windows?.weekly?.usedFraction >= 1) {
    out(`  ${C.yellow('Note:')} /usage reports the weekly window at 100% used, so any spend beyond`);
    out(`  ${C.dim('the ceiling is on credits. A ceiling derived from observed tokens in this')}`);
    out(`  ${C.dim('state is an upper bound, not the limit — prefer the 429 anchors above.')}`);
    out('');
  }

  if (flags.write || flags.yes) {
    const file = writeConfigPatch({ policy: { limits: suggestions } });
    out(`  ${C.green('✓')} wrote ceilings to ${file}`);
  } else {
    out(`  Re-run with ${C.cyan('--write')} to save these to ${CONFIG_FILE()}`);
  }
  out('');
}

export async function cmdUsage(argv) {
  const { flags } = parseFlags(argv);
  const cfg = loadConfig();
  const policy = normalizePolicy(cfg.policy || {});
  const report = await claudeUsageReport({ weights: policy.weights });

  if (flags.json) { out(JSON.stringify(report, null, 2)); return; }

  out('');
  out(`  ${C.bold('Real Claude usage on this machine')} ${C.dim(`(${report.events.toLocaleString?.() ?? report.events} records, ${report.scannedFiles} transcripts)`)}`);
  out('');
  for (const [name, w] of Object.entries(report.windows)) {
    out(`  ${C.bold(name.padEnd(6))} ${String(w.totals.requests).padStart(6)} requests   ` +
        `${fmt(w.totals.input + w.totals.output).padStart(8)} in+out   ` +
        `${fmt(w.totals.cacheRead).padStart(8)} cache read   ` +
        `${C.cyan(fmt(w.weighted).padStart(8))} weighted`);
    for (const [model, t] of Object.entries(w.byModel)) {
      out(`         ${C.dim(model.padEnd(22))} ${String(t.requests).padStart(6)} req  ${C.dim(fmt(t.weighted) + ' weighted')}`);
    }
  }
  out('');
  out(`  ${C.dim(`weights: input ${policy.weights.input} · output ${policy.weights.output} · cache-create ${policy.weights.cacheCreation} · cache-read ${policy.weights.cacheRead}`)}`);
  out(`  ${C.dim('Anthropic does not publish how these count toward subscription limits;')}`);
  out(`  ${C.dim('tune policy.weights if your own experience says otherwise.')}`);
  out('');
}

export async function cmdMode(argv) {
  const { flags, positional } = parseFlags(argv);
  const mode = positional[0] ? resolveModeName(positional[0]) : positional[0];
  if (!mode) {
    const cfg = loadConfig();
    const current = normalizePolicy(cfg.policy || {});
    out('');
    out(`  current mode: ${C.cyan(current.mode)}`);
    out('');
    for (const [name, m] of Object.entries(MODES)) {
      out(`  ${name === current.mode ? C.green('●') : C.dim('○')} ${C.bold(name.padEnd(14))} ${m.description}`);
      out(`    ${C.dim(PURPOSES.map((p) => `${p}:${m.floors[p] >= NEVER ? 'local' : pct(m.floors[p])}`).join('  '))}`);
    }
    out('');
    for (const [alias, target] of Object.entries(MODE_ALIASES)) {
      out(`  ${C.dim(`("${alias}" still works — it now means ${target})`)}`);
    }
    out('');
    out(`  ${C.dim('blaude mode claude-first --floor 20%      use Claude until 20% of allowance remains')}`);
    out(`  ${C.dim('blaude mode split --floor main=35,audit=5 per-purpose floors')}`);
    out('');
    return;
  }
  if (!MODES[mode]) throw new Error(`Unknown mode "${mode}". Known: ${Object.keys(MODES).join(', ')}`);

  let floors = null;
  if (flags.floor) {
    floors = {};
    const spec = String(flags.floor);
    if (spec.includes('=')) {
      for (const pair of spec.split(',')) {
        const [k, v] = pair.split('=');
        floors[k.trim()] = Number(String(v).replace('%', ''));
      }
    } else {
      const v = Number(spec.replace('%', ''));
      for (const p of ['main', 'tools']) floors[p] = v;
    }
  }

  // Floors written for a PREVIOUS mode must not survive a mode switch — they
  // would silently override the new mode's presets, so the mode would say one
  // thing and the routing would do another. Clearing them is the whole point of
  // choosing a mode. `--keep-floors` opts out for hand-tuned configs.
  ensureHome();
  const file = CONFIG_FILE();
  const current = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const policy = { ...(current.policy || {}), mode };
  const previousFloors = current.policy?.floors;
  let cleared = null;

  if (floors) {
    policy.floors = floors;
  } else if (previousFloors && !flags.keepFloors) {
    delete policy.floors;
    cleared = previousFloors;
  }

  normalizePolicy(policy); // validate before writing
  writeFileSync(file, JSON.stringify({ ...current, policy }, null, 2) + '\n');

  const effective = normalizePolicy(policy);
  out(`${C.green('✓')} mode set to ${C.cyan(mode)}${floors ? ` with floors ${JSON.stringify(floors)}` : ''}`);
  if (cleared) {
    out(`  ${C.yellow('!')} cleared floors left over from the previous mode: ${JSON.stringify(cleared)}`);
    out(`  ${C.dim('pass --keep-floors to preserve hand-tuned floors across a mode switch')}`);
  }
  out(`  ${C.dim('effective floors: ' + PURPOSES.map((p) => `${p}=${effective.floors[p] >= NEVER ? 'local' : pct(effective.floors[p])}`).join('  '))}`);
  out(C.dim(`  ${file}`));
}

export async function cmdWhy(argv) {
  const { positional, flags } = parseFlags(argv);
  const cfg = loadConfig();
  const { policy, meter } = await meterFor(cfg);
  const model = positional[0] || cfg.defaultModel;

  const bodies = {
    'fresh user turn': { model, messages: [{ role: 'user', content: 'implement the thing' }] },
    'agent loop (tool result)': { model, messages: [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] },
    ] },
    'audit request': { model: `audit/${model}`, messages: [{ role: 'user', content: 'review this diff' }] },
    'background call': { model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'title this' }] },
  };

  out('');
  out(`  ${C.bold(`Routing for model "${model}"`)}   ${C.dim(`mode ${policy.mode}`)}`);
  out('');
  for (const [label, body] of Object.entries(bodies)) {
    const d = decide({ policy, meter, body, requestedModel: body.model });
    let target = d.destination === 'cloud' ? C.magenta(`Claude ${d.model}`) : C.green('local');
    if (d.destination === 'local') {
      const r = resolveModel(cfg, d.model && cfg.models[d.model] ? d.model : model);
      target = C.green(`local ${r.backendName}/${r.model}`);
    }
    out(`  ${label.padEnd(26)} -> ${target}`);
    out(`  ${''.padEnd(26)}    ${C.dim(d.reason)}`);
  }
  out('');
}

export async function cmdDoctor(argv = []) {
  const { flags } = parseFlags(argv);
  const flagsNoContext = Boolean(flags['no-context']);
  const cfg = loadConfig();
  const policy = normalizePolicy(cfg.policy || {});
  let problems = 0;
  const ok = (m) => out(`  ${C.green('✓')} ${m}`);
  const warn = (m) => { problems++; out(`  ${C.yellow('!')} ${m}`); };
  const bad = (m) => { problems++; out(`  ${C.red('✗')} ${m}`); };

  out('');
  out(`  ${C.bold('Blaude doctor')}`);
  out('');
  ok(`config ${cfg.configSource}`);
  ok(`mode ${policy.mode}, cloud transport ${policy.cloudTransport}`);

  // claude CLI
  const which = spawnSync(process.env.BLAUDE_CLAUDE_BIN || 'claude', ['--version'], { encoding: 'utf8' });
  if (which.status === 0) ok(`claude CLI ${which.stdout.trim()}`);
  else bad('claude CLI not found — cloud escalation and `blaude` launching need it');

  // local backends
  for (const [name, m] of Object.entries(cfg.models)) {
    const backend = cfg.backends[m.backend];
    if (!['openai', 'ollama'].includes(backend.kind)) continue;
    const key = capabilityKey(m.backend, m.model);
    const probe = await probeBackend({ baseUrl: backend.baseUrl, apiKey: backend.apiKey, kind: backend.kind, model: m.model, timeoutMs: 90_000 });
    saveCapability(key, probe);
    if (!probe.reachable) {
      bad(`${name} -> ${key} unreachable at ${backend.baseUrl} (${probe.error})`);
    } else if (probe.nativeToolCalls) {
      ok(`${name} -> ${key} responds, native tool calling works (${(probe.ms / 1000).toFixed(1)}s probe)`);
    } else if (probe.textToolCalls) {
      warn(`${name} -> ${key} emits tool calls as text — Blaude will parse them (textToolCalls=${cfg.textToolCalls})`);
    } else {
      warn(`${name} -> ${key} did not produce a tool call. Coding agents need tools; consider a tool-capable model or capabilityRouting.toolsRequireClaude`);
    }

    // Context ceiling. Claude Code sends 20k-40k token prompts; a server that
    // silently truncates will look like a bad model instead of a bad setting.
    if (probe.reachable && !flagsNoContext) {
      const ctx = await probeContext({ baseUrl: backend.baseUrl, apiKey: backend.apiKey, kind: backend.kind, model: m.model, numCtx: m.maxContext, targetTokens: 24_000 });
      if (!ctx.ok) {
        warn(`${key} context probe failed (${ctx.error})`);
      } else if (ctx.truncated) {
        bad(`${key} TRUNCATES long prompts: sent ~24k tokens, server accepted ${ctx.reportedPromptTokens ?? '?'} and dropped the rest.`);
        out(`      ${C.dim('Claude Code sends 20k-40k token prompts, so this silently destroys your system')}`);
        out(`      ${C.dim('prompt and tool definitions. For Ollama, raise the server context and restart:')}`);
        out(`      ${C.cyan('OLLAMA_CONTEXT_LENGTH=65536 ollama serve')}   ${C.dim('(or set it in the Ollama app settings)')}`);
        out(`      ${C.dim(`Also set models.${name}.maxContext in your Blaude config so it can warn early.`)}`);
        saveCapability(key, { ...probe, effectiveContext: ctx.reportedPromptTokens });
      } else {
        ok(`${key} accepted a ~24k token prompt without truncation`);
      }
    }
  }

  // allowance
  const meter = new AllowanceMeter({ policy });
  await meter.refresh(true);
  if (meter.uncalibrated) warn('no allotments set — Claude routing stays off until you run `blaude calibrate --write`');
  else {
    const t = meter.tightest();
    ok(`allowance ${pct(t.fractionRemaining)} of ${t.name} remaining (${fmt(t.spent)}/${fmt(t.amount)})`);
  }

  // port
  const health = await gatewayHealth(cfg);
  if (health) ok(`gateway already up on ${cfg.host}:${cfg.port}`);
  else out(`  ${C.dim('·')} gateway not running (that is fine — it starts on demand)`);

  out('');
  out(problems ? `  ${problems} thing${problems > 1 ? 's' : ''} to look at` : `  ${C.green('all clear')}`);
  out('');
}

/** Hand the current work to Claude for review, using the subscription. */
export async function cmdAudit(argv) {
  const { flags, positional } = parseFlags(argv);
  const cfg = loadConfig();
  const policy = normalizePolicy(cfg.policy || {});
  const model = flags.model || policy.cloudModels.audit || 'opus';
  const cwd = flags.cwd || process.cwd();
  const { tight } = await assertAllowance('audit', { force: Boolean(flags.force), label: 'An audit' });

  const git = (args) => spawnSync('git', args, { cwd, encoding: 'utf8' }).stdout?.trim() || '';
  const isRepo = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd, encoding: 'utf8' }).status === 0;

  const task = positional.join(' ') || flags.task || '(not stated)';
  const parts = [`## Task the local model was given\n${task}`];

  if (isRepo) {
    const base = flags.base || 'HEAD';
    const diff = flags.staged ? git(['diff', '--cached']) : git(['diff', base]);
    const untracked = git(['ls-files', '--others', '--exclude-standard']);
    parts.push(`## Branch\n${git(['rev-parse', '--abbrev-ref', 'HEAD'])}`);
    parts.push(`## Diff vs ${base}\n\`\`\`diff\n${diff || '(no changes)'}\n\`\`\``);
    if (untracked) parts.push(`## Untracked files\n${untracked}`);
  } else {
    parts.push('## Repo\nNot a git repository — reviewing described work only.');
    if (flags.files) {
      for (const f of String(flags.files).split(',')) {
        if (existsSync(f)) parts.push(`## ${f}\n\`\`\`\n${readFileSync(f, 'utf8').slice(0, 20000)}\n\`\`\``);
      }
    }
  }

  if (flags.tests) {
    const r = spawnSync('sh', ['-c', String(flags.tests)], { cwd, encoding: 'utf8' });
    parts.push(`## Test output (\`${flags.tests}\`, exit ${r.status})\n\`\`\`\n${(r.stdout + r.stderr).slice(-8000)}\n\`\`\``);
  }

  const brief = [
    'You are auditing work produced by a smaller local model. Be specific and skeptical.',
    'Report, in order: (1) correctness bugs with a concrete failure scenario, (2) missed',
    'requirements from the task, (3) anything unsafe or destructive, (4) simplifications',
    'that matter. Skip praise. If the work is sound, say so in one line and stop.',
    '',
    ...parts,
  ].join('\n');

  out('');
  out(`  ${C.bold('Audit')} ${C.dim(`-> Claude ${model} (subscription, via CLI)`)}`);
  if (tight) out(`  ${C.dim(`${pct(tight.fractionRemaining)} of ${tight.name} allowance left`)}`);
  out(`  ${C.dim(`${brief.length.toLocaleString()} chars of context from ${cwd}`)}`);
  out('');

  const t0 = Date.now();
  const result = await runClaudeCLI({
    prompt: brief,
    model,
    cwd,
    allowedTools: flags.allowTools ? String(flags.allowTools).split(',') : [],
    timeoutMs: Number(flags.timeout || 600) * 1000,
    lean: flags.lean !== 'false' && !flags.fat,
  });
  out(result.text);
  out('');
  out(C.dim(`  ${((Date.now() - t0) / 1000).toFixed(1)}s · ${result.usage?.input_tokens ?? '?'} in / ${result.usage?.output_tokens ?? '?'} out` +
      (result.costUsd != null ? ` · CLI reports $${result.costUsd.toFixed(4)}` : '')));
  out('');
}

/** Try policies against your real history without spending anything. */
export async function cmdSimulate(argv) {
  const { flags } = parseFlags(argv);
  const cfg = loadConfig();
  const days = Number(flags.days || 7);
  const base = normalizePolicy(cfg.policy || {});

  out('');
  out(`  ${C.bold('Simulating')} against ${days} days of real Claude usage…`);
  const events = await loadHistory({ days });
  if (!events.length) { out(`  ${C.yellow('no Claude usage in that window')}`); return; }
  if (!Object.values(base.limits).some((l) => l.amount > 0)) {
    out(`  ${C.yellow('no allotments set — run `blaude calibrate --write` first')}`);
    return;
  }

  const candidates = [];
  if (flags.mode) {
    candidates.push([`${flags.mode}${flags.floor ? ` @ ${flags.floor}` : ''}`, buildPolicy(cfg, flags.mode, flags.floor)]);
  } else {
    candidates.push(['local-only', buildPolicy(cfg, 'local-only')]);
    candidates.push(['local-first', buildPolicy(cfg, 'local-first')]);
    candidates.push(['claude-first @ 20%', buildPolicy(cfg, 'claude-first', '20')]);
    candidates.push(['claude-first @ 10%', buildPolicy(cfg, 'claude-first', '10')]);
    candidates.push(['claude-first @ 0%', buildPolicy(cfg, 'claude-first', '0')]);
    candidates.push(['split @ 35%', buildPolicy(cfg, 'split', '35')]);
  }

  out(`  ${events.length.toLocaleString()} requests · allotments ` +
      Object.entries(base.limits).filter(([, l]) => l.amount).map(([n, l]) => `${n} ${fmt(l.amount)}/${l.period}`).join(', '));
  out('');
  out(`  ${'configuration'.padEnd(20)} ${'Claude req'.padStart(11)} ${'local req'.padStart(10)} ${'Claude tok'.padStart(11)} ${'handoffs'.padStart(9)}`);
  out(`  ${C.dim('-'.repeat(66))}`);
  for (const [label, policy] of candidates) {
    const r = simulate({ policy, events });
    out(`  ${label.padEnd(20)} ${(String(r.requests.cloud) + ` (${Math.round(r.cloudShareOfRequests * 100)}%)`).padStart(11)} ` +
        `${String(r.requests.local).padStart(10)} ${fmt(r.tokens.cloud).padStart(11)} ${String(r.handoffs.length).padStart(9)}`);
    if (flags.verbose) {
      const first = r.handoffs.find((h) => h.to === 'local');
      if (first) out(`  ${C.dim(`  first fallback ${first.at.slice(0, 16).replace('T', ' ')} at ${pct(first.remaining)} remaining`)}`);
      out(`  ${C.dim('  ' + Object.entries(r.byPurpose).map(([p, v]) => `${p} ${v.cloud}c/${v.local}l`).join('  '))}`);
    }
  }
  out('');
  out(`  ${C.dim('Purpose is inferred from timing (>30s gap = a human typing = a new turn),')}`);
  out(`  ${C.dim('and locally-served requests are assumed to have been satisfiable locally.')}`);
  out('');
}

function buildPolicy(cfg, mode, floor) {
  const patch = { ...(cfg.policy || {}), mode };
  if (floor != null) {
    const v = Number(String(floor).replace('%', ''));
    patch.floors = { ...(cfg.policy?.floors || {}), main: v, tools: v };
  } else {
    delete patch.floors; // use the mode's own floors
  }
  return normalizePolicy(patch);
}

export async function cmdStats(argv) {
  const { flags } = parseFlags(argv);
  const cfg = loadConfig();
  const entries = await readUsage(cfg);
  if (!entries.length) { out('No Blaude requests logged yet.'); return; }
  const s = summarize(entries, cfg.pricing || {});
  if (flags.json) { out(JSON.stringify(s, null, 2)); return; }

  out('');
  out(`  ${C.bold('Blaude request log')}  ${entries.length} requests, ${s.errors} errors`);
  out('');
  for (const [target, agg] of Object.entries(s.byTarget)) {
    const avg = agg.requests ? (agg.ms / agg.requests / 1000).toFixed(1) : '0';
    const tps = agg.ms ? (agg.outputTokens / (agg.ms / 1000)).toFixed(1) : '—';
    out(`  ${(agg.cloud ? C.magenta('claude') : C.green('local ')) } ${target.padEnd(28)} ` +
        `${String(agg.requests).padStart(5)} req  ${fmt(agg.inputTokens).padStart(8)} in  ` +
        `${fmt(agg.outputTokens).padStart(8)} out  ${avg.padStart(6)}s avg  ${tps} tok/s`);
  }
  out('');
  const byPurpose = {};
  for (const e of entries) byPurpose[e.purpose || 'unknown'] = (byPurpose[e.purpose || 'unknown'] || 0) + 1;
  out(`  by purpose  ${Object.entries(byPurpose).map(([k, v]) => `${k}:${v}`).join('  ')}`);
  out('');
}

/**
 * Continue a Claude session on the local model. Free: the transcript is read
 * from disk, so this works with zero allowance left.
 */
export async function cmdResume(argv) {
  const { flags, positional } = parseFlags(argv);
  const cfg = loadConfig();
  const cwd = flags.cwd || process.cwd();

  const sessions = await listSessions({ cwd, limit: Number(flags.limit || 10), allProjects: Boolean(flags.all) });
  if (!sessions.length) {
    out(`  ${C.yellow('No Claude sessions found for')} ${cwd}`);
    out(`  ${C.dim('Pass --all to look across every project.')}`);
    return;
  }

  // No target given: list what is available and stop.
  const target = positional[0] || (flags.last ? sessions[0].sessionId : flags.session);
  if (!target) {
    out('');
    out(`  ${C.bold('Claude sessions for this project')}  ${C.dim('(reading these costs nothing)')}`);
    out('');
    sessions.forEach((s, i) => {
      const when = new Date(s.mtime).toISOString().slice(0, 16).replace('T', ' ');
      out(`  ${String(i + 1).padStart(2)}. ${C.cyan(s.sessionId.slice(0, 8))} ${when}  ${String(s.records).padStart(5)} records  ${C.dim(s.slug || '')}`);
      if (s.firstUser) out(`      ${C.dim(s.firstUser.slice(0, 96))}`);
    });
    out('');
    out(`  ${C.dim('blaude resume --last            hand the newest session to the local model')}`);
    out(`  ${C.dim('blaude resume <session-id>      pick one')}`);
    out(`  ${C.dim('blaude resume --last --print    just print the briefing')}`);
    out('');
    return;
  }

  const picked = sessions.find((s) => s.sessionId.startsWith(target)) || sessions[Number(target) - 1];
  if (!picked) throw new Error(`No session matching "${target}"`);

  const digest = await digestSession(picked.path, {
    maxChars: Number(flags.maxChars || 24_000),
    includeToolResults: Boolean(flags.toolResults),
  });

  const notes = readNotes({ cwd });
  const briefing = notes
    ? `${digest.text}\n## Blaude notes for this project\n${notes}\n`
    : digest.text;

  if (flags.print) {
    out(briefing);
    return;
  }

  out('');
  out(`  ${C.bold('Handing off to the local model')}`);
  out(`  ${C.dim(`session ${picked.sessionId.slice(0, 8)} · ${digest.stats.records} records · ` +
      `${(digest.stats.sourceChars / 1000).toFixed(0)}k chars compressed to ${(digest.stats.digestChars / 1000).toFixed(1)}k`)}`);
  out(`  ${C.dim(`${digest.stats.userTurns} user turns · ${digest.stats.toolCalls} tool calls · ${digest.stats.filesTouched} files touched`)}`);
  out(`  ${C.green('$0')} ${C.dim('— transcripts are read from disk, no API call involved')}`);
  out('');

  await ensureGateway(cfg);
  const env = { ...process.env, ...localSessionEnv(cfg) };
  const localArgs = localSessionArgs(cfg);
  const prompt = `${briefing}\n---\nAcknowledge in one sentence what state the work is in, then continue.`;
  const child = spawn(process.env.BLAUDE_CLAUDE_BIN || 'claude', [...localArgs, prompt], { stdio: 'inherit', env, cwd });
  child.on('exit', (code) => process.exit(code ?? 0));
}

/**
 * The guard hook. Claude Code runs this on every prompt submission, so it must
 * be instant and it must fail open — a broken guard should never wedge a session.
 *
 * It only acts in a NATIVE Claude session. In a Blaude-hosted session the
 * gateway is already enforcing policy per request, and local tokens are free.
 */
export async function cmdHook(argv) {
  const { flags } = parseFlags(argv);
  const emit = (obj) => { if (obj) out(JSON.stringify(obj)); process.exit(0); };

  try {
    // Drain stdin so Claude Code never blocks on a full pipe.
    await new Promise((resolve) => {
      let buf = '';
      if (process.stdin.isTTY) return resolve();
      process.stdin.on('data', (c) => { buf += c; });
      process.stdin.on('end', resolve);
      process.stdin.on('error', resolve);
      setTimeout(resolve, 500);
    });

    // A Blaude-hosted session routes through the gateway already.
    const cfg = loadConfig();
    const base = process.env.ANTHROPIC_BASE_URL || '';
    if (base.includes(`:${cfg.port}`) || process.env.BLAUDE_SESSION === 'local') emit(null);

    const policy = normalizePolicy(cfg.policy || {});
    const report = await readUsageCached({ ttlMs: Number(flags.ttl || 60) * 1000 });
    if (!report?.windows) emit(null);

    // Tightest account-wide window, ignoring per-model ones.
    let tight = null;
    for (const [name, w] of Object.entries(report.windows)) {
      if (w.model || w.fractionRemaining == null) continue;
      if (!tight || w.fractionRemaining < tight.fractionRemaining) tight = { name, ...w };
    }
    if (!tight) emit(null);

    const floor = Math.max(
      policy.floors?.main ?? 0,
      // Never let a session run the account to zero unnoticed.
      policy.handoff?.hardStopFraction ?? 0.02,
    );
    const warnAt = Math.min(1, floor + 0.1);
    const left = pct(tight.fractionRemaining);
    const resets = tight.resetsAt ? ` Resets ${tight.resetsAt}.` : '';

    if (floor < 1 && tight.fractionRemaining <= floor) {
      emit({
        decision: 'block',
        reason:
          `Blaude: only ${left} of your ${tight.name} Claude allowance remains, at or below your ` +
          `${pct(floor)} floor.${resets} Continuing here spends usage credits.\n\n` +
          `Hand off to the local model instead — exit this session and run:\n` +
          `    blaude -c\n\n` +
          `That continues this same conversation on ${cfg.defaultModel} for free. ` +
          `To override and keep using Claude: \`blaude guard off\`, or raise the floor with ` +
          `\`blaude mode claude-first --floor 5%\`.`,
        systemMessage: `Blaude blocked this prompt: ${left} of ${tight.name} allowance left (floor ${pct(floor)}).`,
      });
    }

    if (tight.fractionRemaining <= warnAt) {
      emit({
        systemMessage:
          `Blaude: ${left} of your ${tight.name} Claude allowance left — ` +
          `handoff to ${cfg.defaultModel} at ${pct(floor)}.${resets}`,
      });
    }

    emit(null);
  } catch (err) {
    // Fail open, loudly enough to debug but never blocking work.
    if (process.env.BLAUDE_DEBUG) console.error(`blaude hook: ${err.message}`);
    process.exit(0);
  }
}

/** Warm the usage cache. Spawned detached by the hook; also useful by hand. */
export async function cmdRefreshUsage() {
  try {
    const report = await readUsageCommand();
    writeUsageCache(report);
    if (process.stdout.isTTY) out(`${C.green('✓')} usage cache refreshed`);
  } catch (err) {
    if (process.stdout.isTTY) out(`${C.yellow('!')} ${err.message}`);
  }
}

/** Install or remove the guard hook in Claude Code's settings. */
export async function cmdGuard(argv) {
  const { flags, positional } = parseFlags(argv);
  const action = positional[0] || 'status';
  const settingsPath = flags.project
    ? join(process.cwd(), '.claude', 'settings.json')
    : join(process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME, '.claude'), 'settings.json');

  const read = () => {
    if (!existsSync(settingsPath)) return {};
    try { return JSON.parse(readFileSync(settingsPath, 'utf8')); } catch (err) {
      throw new Error(`${settingsPath} is not valid JSON (${err.message}) — fix it before installing the guard`);
    }
  };
  const blaudeBin = process.env.BLAUDE_CLAUDE_HOOK_BIN
    || join(import.meta.dirname, '..', 'bin', 'blaude.mjs');
  const command = `node ${blaudeBin} hook`;
  const isOurs = (h) => typeof h?.command === 'string' && /blaude(\.mjs)?['"]? hook\b/.test(h.command);

  const settings = read();
  const entries = settings.hooks?.UserPromptSubmit || [];
  const installed = entries.some((e) => (e.hooks || []).some(isOurs));

  if (action === 'status') {
    out('');
    out(`  guard: ${installed ? C.green('installed') : C.dim('not installed')}   ${C.dim(settingsPath)}`);
    out(`  ${C.dim('The guard blocks a prompt in a NATIVE Claude session once your allowance')}`);
    out(`  ${C.dim('drops to the floor, and tells you to continue locally with `blaude -c`.')}`);
    out(`  ${C.dim('It does nothing in a Blaude-hosted session — the gateway already routes.')}`);
    out('');
    out(`  ${C.cyan('blaude guard on')}    install it`);
    out(`  ${C.cyan('blaude guard off')}   remove it`);
    out('');
    return;
  }

  if (action === 'on') {
    if (installed) { out(`${C.dim('guard already installed')} ${C.dim(settingsPath)}`); return; }
    const next = { ...settings };
    next.hooks = { ...(settings.hooks || {}) };
    // Merge, never replace: other UserPromptSubmit hooks must survive.
    next.hooks.UserPromptSubmit = [
      ...entries,
      { hooks: [{ type: 'command', command, timeout: 10, statusMessage: 'Checking Claude allowance…' }] },
    ];
    if (!existsSync(join(settingsPath, '..'))) mkdirSync(join(settingsPath, '..'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(next, null, 2) + '\n');
    out('');
    out(`  ${C.green('✓')} guard installed in ${settingsPath}`);
    out(`  ${C.dim('Open /hooks once (or restart Claude Code) so the new hook is picked up.')}`);
    out(`  ${C.dim('Native Claude sessions will now stop at your floor instead of overrunning.')}`);
    out('');
    return;
  }

  if (action === 'off') {
    if (!installed) { out(`${C.dim('guard is not installed')}`); return; }
    const next = { ...settings, hooks: { ...(settings.hooks || {}) } };
    next.hooks.UserPromptSubmit = entries
      .map((e) => ({ ...e, hooks: (e.hooks || []).filter((h) => !isOurs(h)) }))
      .filter((e) => (e.hooks || []).length);
    if (!next.hooks.UserPromptSubmit.length) delete next.hooks.UserPromptSubmit;
    if (!Object.keys(next.hooks).length) delete next.hooks;
    writeFileSync(settingsPath, JSON.stringify(next, null, 2) + '\n');
    out(`${C.green('✓')} guard removed from ${settingsPath}`);
    return;
  }

  throw new Error(`Unknown action "${action}". Use: blaude guard [status|on|off]`);
}

/** A durable per-project scratchpad that survives model handoffs. */
export async function cmdNote(argv) {
  const { flags, positional } = parseFlags(argv);
  const cwd = flags.cwd || process.cwd();
  const text = positional.join(' ');
  if (!text) {
    const notes = readNotes({ cwd });
    out('');
    out(notes ? `  ${C.bold('Notes for this project')}\n\n${notes}` : `  ${C.dim('No notes yet. Add one: blaude note "…"')}`);
    out('');
    return;
  }
  const file = appendNote(text, { cwd });
  out(`${C.green('✓')} noted ${C.dim(`(${file})`)}`);
}

/**
 * Point Blaude at an Ollama on another machine.
 *
 * The remote host must be serving on its LAN interface (OLLAMA_HOST=0.0.0.0
 * ollama serve). Ollama has no authentication, so only do this on a network you
 * trust — anyone who can reach the port can use the model.
 */
export async function cmdRemote(argv) {
  const { flags, positional } = parseFlags(argv);
  const cfg = loadConfig();
  const url = positional[0];

  if (!url) {
    out('');
    out(`  ${C.bold('Configured backends')}`);
    for (const [name, b] of Object.entries(cfg.backends)) {
      const where = b.baseUrl || '(n/a)';
      const local = /127\.0\.0\.1|localhost/.test(where);
      out(`    ${name.padEnd(12)} ${b.kind.padEnd(10)} ${where} ${local ? C.dim('(this machine)') : C.cyan('(remote)')}`);
    }
    out('');
    out(`  ${C.dim('blaude remote http://192.168.1.50:11434 --model qwen3:32b')}`);
    out(`  ${C.dim('On the remote machine: OLLAMA_HOST=0.0.0.0 ollama serve')}`);
    out('');
    return;
  }

  let parsed;
  try { parsed = new URL(url); } catch { throw new Error(`"${url}" is not a URL. Try http://192.168.1.50:11434`); }
  const base = `${parsed.protocol}//${parsed.host}`;

  out('');
  out(`  ${C.bold('Checking')} ${base} …`);
  let version = null;
  let models = [];
  try {
    const v = await fetch(`${base}/api/version`, { signal: AbortSignal.timeout(5000) });
    if (v.ok) version = (await v.json()).version;
    const t = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(8000) });
    if (t.ok) models = ((await t.json()).models || []).map((m) => m.name);
  } catch (err) {
    out(`  ${C.red('✗')} cannot reach it: ${err.message}`);
    out('');
    out(`  ${C.dim('On the remote machine, Ollama must listen beyond localhost:')}`);
    out(`  ${C.cyan('OLLAMA_HOST=0.0.0.0 OLLAMA_CONTEXT_LENGTH=65536 ollama serve')}`);
    out(`  ${C.dim('and its firewall must allow the port.')}`);
    out('');
    return;
  }

  out(`  ${C.green('✓')} Ollama ${version || '(version unknown)'} with ${models.length} model(s)`);
  if (models.length) out(`    ${C.dim(models.slice(0, 12).join(', '))}`);

  const model = flags.model || models[0];
  if (!model) { out(`  ${C.yellow('!')} no models installed there — pull one first`); return; }
  if (!models.includes(model) && !flags.force) {
    out(`  ${C.yellow('!')} "${model}" is not on that host. Available: ${models.join(', ')}`);
    out(`  ${C.dim('Pass --force to configure it anyway.')}`);
    return;
  }

  const backendName = flags.name || 'remote';
  const patch = {
    backends: { [backendName]: { kind: 'ollama', baseUrl: base, apiKey: null } },
    models: {
      'blaude-remote': {
        backend: backendName,
        model,
        maxContext: Number(flags.context || 65536),
        maxOutput: Number(flags.maxOutput || 8192),
      },
    },
  };
  if (!flags.keepDefault) patch.defaultModel = 'blaude-remote';

  const file = writeConfigPatch(patch);
  out('');
  out(`  ${C.green('✓')} ${flags.keepDefault ? 'added' : 'added and set as default'}: blaude-remote -> ${backendName}/${model}`);
  out(`  ${C.dim(file)}`);
  out(`  ${C.dim('Blaude has no authentication and neither does Ollama — use this on trusted networks only.')}`);
  out(`  ${C.dim('Next: blaude doctor')}`);
  out('');
}

/**
 * A web search a local model can actually use.
 *
 * Claude Code's WebSearch tool runs client-side but queries Anthropic's service,
 * so it returns nothing in a locally-served session — and a small model handed an
 * empty result set will invent an answer. This routes the search through the
 * official CLI instead: the local model calls `blaude search` over Bash, and gets
 * real, sourced results back. Cheap compared with running the whole turn on Claude.
 */
export async function cmdSearch(argv) {
  const { flags, positional } = parseFlags(argv);
  const cfg = loadConfig();
  const policy = normalizePolicy(cfg.policy || {});
  const query = positional.join(' ');
  if (!query) throw new Error('usage: blaude search "what you want to know"');

  const model = flags.model || policy.cloudModels.tools || 'haiku';
  await assertAllowance('tools', { force: Boolean(flags.force), label: 'A web search' });
  const t0 = Date.now();
  const result = await runClaudeCLI({
    prompt:
      `Search the web and answer this factually: ${query}\n\n` +
      'Return only findings, each with its source URL. Be concise. If the search ' +
      'returns nothing useful, say exactly that — do not answer from memory.',
    model,
    allowedTools: ['WebSearch', 'WebFetch'],
    cwd: flags.cwd || process.cwd(),
    timeoutMs: Number(flags.timeout || 180) * 1000,
  });

  if (flags.json) {
    out(JSON.stringify({ query, model, text: result.text, usage: result.usage, ms: Date.now() - t0 }, null, 2));
  } else {
    out(result.text);
    if (!flags.quiet) {
      out('');
      out(C.dim(`  [blaude search via Claude ${model} · ${((Date.now() - t0) / 1000).toFixed(1)}s · ` +
          `${result.usage?.input_tokens ?? '?'} in / ${result.usage?.output_tokens ?? '?'} out]`));
    }
  }
}

/** Inspect or raise the local Ollama daemon's context cap. */
export async function cmdOllama(argv) {
  const { flags, positional } = parseFlags(argv);
  const [sub, value] = positional;
  const detected = detectOllama();

  if (!sub || sub === 'status') {
    const loaded = await loadedContexts();
    out('');
    out(`  ${C.bold('Ollama')}  ${detected.running ? C.green(`running as the ${detected.flavour === 'app' ? 'menu-bar app' : '`ollama serve` process'} (pid ${detected.pid})`) : C.red('not running')}`);
    out(`  OLLAMA_CONTEXT_LENGTH  ${detected.launchctlValue || detected.envValue || C.dim('unset (daemon default applies)')}`);
    if (loaded.length) {
      out('');
      out(`  ${C.bold('Loaded models')}`);
      for (const m of loaded) {
        out(`    ${m.name.padEnd(20)} context ${String(m.contextLength ?? '?').padStart(7)}   ${m.sizeVram ? C.dim((m.sizeVram / 1e9).toFixed(1) + ' GB resident') : ''}`);
      }
    }
    out('');
    out(`  ${C.dim('The daemon clamps per-request num_ctx to its own ceiling, so raising the cap')}`);
    out(`  ${C.dim('means changing the daemon setting and restarting it:')}`);
    out(`  ${C.cyan('blaude ollama context 65536')}`);
    out('');
    return;
  }

  if (sub !== 'context') throw new Error(`Unknown subcommand "${sub}". Use: blaude ollama [status|context <tokens>]`);
  const tokens = Number(value);
  if (!Number.isFinite(tokens) || tokens < 2048) throw new Error('Give a context size in tokens, e.g. `blaude ollama context 65536`');

  const plan = planContextChange(tokens, detected);
  out('');
  out(`  ${C.bold(`Raise Ollama's context cap to ${plan.value.toLocaleString()} tokens`)}`);
  out(`  ${C.dim('A bigger context costs RAM: the KV cache grows with context length and model')}`);
  out(`  ${C.dim('size, and it competes with the weights for your unified memory.')}`);
  out('');
  plan.steps.forEach((s, i) => {
    out(`  ${i + 1}. ${s.description}`);
    out(`     ${C.dim('$ ' + s.command)}`);
  });
  out('');

  if (!flags.apply) {
    out(`  Nothing changed. Re-run with ${C.cyan('--apply')} to perform these steps,`);
    out(`  or run the commands yourself.`);
    out('');
    return;
  }

  out(`  ${C.bold('Applying…')}  ${C.dim('(this restarts Ollama; in-flight generations will be cut off)')}`);
  for (const step of plan.steps) {
    const r = applyStep(step);
    out(`  ${r.ok ? C.green('✓') : C.red('✗')} ${step.description}${r.stderr ? C.dim(' — ' + r.stderr) : ''}`);
    if (!r.ok) {
      out(`  ${C.yellow('!')} stopped early; run the remaining commands by hand`);
      return;
    }
  }
  const back = await waitForOllama();
  out(`  ${back ? C.green('✓') : C.yellow('!')} Ollama ${back ? 'is back up' : 'has not come back yet — check the app'}`);
  writeConfigPatch({ models: { blaude: { maxContext: plan.value } } });
  out(`  ${C.green('✓')} recorded maxContext ${plan.value} for the default model`);
  out(`  ${C.dim('verify with: blaude doctor')}`);
  out('');
}

export async function cmdInit(argv) {
  const { flags } = parseFlags(argv);
  const file = flags.local ? join(process.cwd(), 'blaude.config.json') : CONFIG_FILE();
  if (existsSync(file) && !flags.force) {
    out(`${C.yellow('!')} ${file} already exists — pass --force to overwrite`);
    return;
  }
  ensureHome();
  const template = {
    port: DEFAULTS.port,
    models: DEFAULTS.models,
    defaultModel: DEFAULTS.defaultModel,
    policy: {
      mode: 'local-first',
      limits: { session: { period: '5h', amount: 0 }, weekly: { period: 'week', amount: 0 } },
      floors: { main: 1, tools: 1, audit: 0.05, background: 1 },
      cloudTransport: 'cli',
      cloudModels: { main: 'sonnet', tools: 'haiku', audit: 'opus', background: 'haiku' },
    },
  };
  writeFileSync(file, JSON.stringify(template, null, 2) + '\n');
  out(`${C.green('✓')} wrote ${file}`);
  out(C.dim('  next: blaude calibrate --write   then   blaude'));
}

export function cmdHelp() {
  out(`
  ${C.bold('blaude')} — keep Claude Code working without burning your Claude allowance

  ${C.bold('blaude')} [claude args…]     start a session; Blaude picks Claude or local for you
    ${C.dim('--local')}                  force the local model
    ${C.dim('--claude')}                 force a native Claude session

  ${C.bold('blaude status')}             allowance, routing table, gateway state
  ${C.bold('blaude usage')}              real Claude usage on this machine ${C.dim('(--json)')}
  ${C.bold('blaude calibrate')}          derive allotments from your own history ${C.dim('(--write)')}
  ${C.bold('blaude mode')} [name]        list or set the mode ${C.dim('(--floor 20%)')}
  ${C.bold('blaude why')} [model]        explain where each kind of request would go
  ${C.bold('blaude audit')} "task"       hand the current diff to Claude for review
  ${C.bold('blaude resume')} [id|--last]  continue a Claude session locally ${C.dim('(free, reads disk)')}
  ${C.bold('blaude note')} "text"         per-project notes that survive a handoff
  ${C.bold('blaude doctor')}             check backends, tool support, context cap, allowance
  ${C.bold('blaude ollama')} [context N]  inspect or raise the local Ollama context cap ${C.dim('(--apply)')}
  ${C.bold('blaude use')} [model]         pick which local model to serve ${C.dim('(lists if omitted)')}
  ${C.bold('blaude route')} [auto|gateway] whether Blaude stays in the request path
  ${C.bold('blaude guard')} [on|off]       stop native Claude sessions at your floor
  ${C.bold('blaude remote')} [url]        use an Ollama on another machine ${C.dim('(--model X)')}
  ${C.bold('blaude search')} "query"      real web search for a local model, via Claude
  ${C.bold('blaude serve')}              run the gateway in the foreground
  ${C.bold('blaude simulate')}           try policies against your real history ${C.dim('(--days 7 --verbose)')}
  ${C.bold('blaude stats')}              what Blaude has served ${C.dim('(--json)')}
  ${C.bold('blaude init')}               write a config file ${C.dim('(--local)')}

  ${C.dim('modes:')} ${Object.keys(MODES).join(', ')}
  ${C.dim('config:')} ${CONFIG_FILE()}
`);
}

const COMMANDS = {
  serve: cmdServe,
  status: cmdStatus,
  usage: cmdUsage,
  calibrate: cmdCalibrate,
  mode: cmdMode,
  why: cmdWhy,
  doctor: cmdDoctor,
  audit: cmdAudit,
  stats: cmdStats,
  simulate: cmdSimulate,
  init: cmdInit,
  ollama: cmdOllama,
  remote: cmdRemote,
  search: cmdSearch,
  resume: cmdResume,
  hook: cmdHook,
  guard: cmdGuard,
  route: cmdRoute,
  use: cmdUse,
  'refresh-usage': cmdRefreshUsage,
  note: cmdNote,
  help: async () => cmdHelp(),
};

/** Levenshtein distance, for catching a mistyped command. */
function editDistance(a, b) {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return rows[a.length][b.length];
}

/**
 * A near-miss on a command name, e.g. `blaude model` for `blaude mode`.
 *
 * This matters because an unrecognised first word would otherwise be treated as
 * a prompt and launch a session — which, above the floor, spends a Claude turn on
 * a typo. Refusing is much better than guessing.
 */
export function nearestCommand(word, names = Object.keys(COMMANDS)) {
  const w = String(word || '').toLowerCase();
  if (!w || !/^[a-z][a-z-]*$/.test(w)) return null;
  let best = null;
  for (const name of names) {
    const d = editDistance(w, name);
    const limit = name.length <= 4 ? 1 : 2;
    if (d > 0 && d <= limit && (!best || d < best.distance)) best = { name, distance: d };
  }
  return best?.name ?? null;
}

export async function main(argv = process.argv.slice(2)) {
  const [first, ...rest] = argv;
  if (first === '--help' || first === '-h' || first === 'help') return cmdHelp();
  if (first === '--version' || first === '-v') return out('blaude 0.1.0');
  if (first && COMMANDS[first]) return COMMANDS[first](rest);

  // `blaude -- anything at all` always means "this is a prompt".
  if (first === '--') return cmdLaunch(rest);

  const suggestion = nearestCommand(first);
  if (suggestion) {
    throw new Error(
      `unknown command "${first}". Did you mean \x1b[36mblaude ${suggestion}\x1b[0m?\n` +
      `  To send it as a prompt instead: \x1b[36mblaude -- ${argv.join(' ')}\x1b[0m`,
    );
  }

  // Anything else is a session: `blaude`, `blaude -c`, `blaude "fix the bug"`.
  return cmdLaunch(argv);
}
