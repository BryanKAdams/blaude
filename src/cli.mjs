// @ts-nocheck — not yet typed. `npm test` runs `tsc --checkJs` over this repo;
// the translation layer (anthropic-to-openai, openai-to-anthropic, stream,
// text-scanner, fit-context) is clean and stays clean. This file is not, so it
// opts out rather than making the check unrunnable. Delete this line, run
// `npm run typecheck`, and fix what it says.
// The `blaude` command line.
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync, existsSync, readFileSync, openSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { totalmem } from 'node:os';
import { loadConfig, BLAUDE_HOME, ensureHome, DEFAULTS } from './config.mjs';
import { startGateway } from './server.mjs';
import {
  normalizePolicy, AllowanceMeter, decide, explainPolicy, MODES, MODE_ALIASES,
  resolveModeName, PURPOSES, pct, fmt, NEVER, PERIOD_MS, parseFloor,
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
import { detectOllama, loadedContexts, planContextChange, applyStep, waitForOllama, modelMemoryProfile, planMemory, availableMemory } from './ollama-admin.mjs';
import { listSessions, digestSession, appendNote, readNotes } from './handoff.mjs';
import { readAccount, cachedAccount, describeAccount, portForAccount } from './account.mjs';
import {
  checkForUpdate, fetchLatestRelease, applyUpdate, rollback, describeInstall,
  installedVersions, currentTarget, updateRepo, writeUpdateCache,
} from './update.mjs';
import { VERSION } from './version.mjs';

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

/**
 * Bind this process to its own account's gateway port.
 *
 * Allowance belongs to an account, and a gateway reads it once under its own
 * environment. Share one gateway between two signed-in accounts and both get
 * routed on whichever account started it — plausible-looking numbers about the
 * wrong subscription, with no visible symptom beyond work quietly going local.
 *
 * This runs once, in `main`, before any command loads config, because doing it
 * per-command is exactly how the two drifted apart: `status` scoped itself and
 * nothing else did, so a `serve` started under one account served every other
 * one on the shared default port. Binding centrally means a call site cannot
 * forget.
 *
 * The port lands in the environment rather than a variable so the detached
 * `serve` child that `ensureGateway` spawns inherits it too.
 */
let accountBinding = null;
export async function bindAccountPort({ env = process.env } = {}) {
  if (accountBinding) return accountBinding;
  const cfg = loadConfig({ env });

  // An explicit port, or an opt-out, is the user overriding us on purpose.
  if (env.BLAUDE_PORT || cfg.accountScopedPort === false) {
    accountBinding = { account: cachedAccount({ env }), port: cfg.port };
    return accountBinding;
  }

  const account = await readAccount({ env }).catch(() => null);
  const port = portForAccount(cfg.port, account);
  if (port !== cfg.port) env.BLAUDE_PORT = String(port);
  accountBinding = { account, port };
  return accountBinding;
}

/** Attach the bound account to a freshly loaded config, for display and checks. */
export async function scopeConfigToAccount(cfg, { quiet = false } = {}) {
  if (cfg.accountScopedPort === false) return cfg;
  const { account } = await bindAccountPort();
  if (account) cfg.account = account;
  return cfg;
}

/**
 * A healthy gateway on our port is not automatically ours.
 *
 * Per-account ports make a collision unlikely but not impossible — the offset is
 * a hash modulo 200, and `accountScopedPort: false` disables it outright. Serving
 * a session from another account's gateway is the failure this whole path exists
 * to prevent, so refuse it loudly instead of adopting it.
 */
export function assertGatewayAccount(health, cfg, account) {
  const mine = account?.key;
  const theirs = health?.account?.key;
  if (!mine || !theirs || mine === theirs) return;
  throw new Error(
    `the gateway on ${cfg.host}:${cfg.port} is signed in as ${health.account.email}, not ${account.email}.\n` +
    `  Its routing comes from that account's allowance, so this session would be sent local (or to Claude)\n` +
    `  on numbers that are not yours. Stop that gateway, then retry.`,
  );
}

async function ensureGateway(cfg, { quiet = false } = {}) {
  const { account } = await bindAccountPort();
  const existing = await gatewayHealth(cfg);
  if (existing) {
    assertGatewayAccount(existing, cfg, account);
    return { started: false, health: existing };
  }

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
    // The guard hook checks this to tell "already routed through Blaude" from a
    // native session. Without it the hook fell back to matching the port, which
    // now varies per account.
    BLAUDE_SESSION: 'local',
    // A local model's prefill is measured in minutes, not seconds. Claude Code's
    // default timeout expires mid prefill and reads as a hang.
    API_TIMEOUT_MS: String(cfg.apiTimeoutMs ?? 900_000),
    // Claude Code's full system prompt is 7,629 tokens and its tool descriptions
    // 27,188; this trades some of that guidance for 5,946 fewer tokens of system
    // prompt and 5,135 fewer of tool text on EVERY turn. A frontier model behind
    // prompt caching does not care; a 27B re-prefilling locally very much does.
    ...(cfg.simpleSystemPrompt === false ? {} : { CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT: '1' }),
    ...(window ? { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(window) } : {}),
  };
}

/**
 * Variables a Blaude-hosted session sets that must not survive into a native one.
 *
 * Credentials are deliberately absent: clearing those would change how a native
 * session authenticates, which is not this function's call to make.
 */
export function localSessionEnvKeys(cfg) {
  return [...new Set([
    ...Object.keys(localSessionEnv(cfg)).filter((k) => !/API_KEY|AUTH_TOKEN/.test(k)),
    // Omitted from the object itself on a small window, so name it explicitly.
    'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  ])];
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
async function assertAllowance(purpose, { force = false, label = purpose, floor: override = null, remedy = null } = {}) {
  const cfg = loadConfig();
  const { policy, meter } = await meterFor(cfg);
  const floor = override ?? policy.floors?.[purpose] ?? NEVER;
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
    // `=1%`, not `=1`. A bare 1 is the "never" sentinel, so the old wording told
    // people to type the one value guaranteed to reproduce this same error.
    const fix = remedy || `lower the floor: blaude mode ${policy.mode} --floor ${purpose}=1%`;
    throw new Error(
      `${label} would spend Claude, but ${why}.\n` +
      `  ${tight.resetsAt ? `Allowance resets ${tight.resetsAt}.\n  ` : ''}` +
      `Override with --force, or ${fix}`,
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
  // `transport: 'native'` because a cloud decision here means exec'ing `claude`
  // with no gateway in the path — the relay's cost never applies to this call.
  const liveDecision = decide({
    policy, meter,
    body: { messages: [{ role: 'user', content: 'session start' }] },
    requestedModel: 'main/session',
    transport: 'native',
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
  // This number decides the whole session. Say when it is a guess, the way
  // `status` does — otherwise an estimate reads exactly like an exact figure.
  if (meter.lastError) note(`  ${C.yellow('!')} ${C.dim(`estimated — \`claude /usage\` unavailable (${meter.lastError})`)}`);
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
    //
    // Clear everything a Blaude-hosted session sets, not just the base URL. An
    // inherited ANTHROPIC_SMALL_FAST_MODEL would point this session's background
    // calls at "blaude-small" with no gateway to serve it, and an inherited
    // BLAUDE_SESSION would tell the guard hook to stand down on the one path it
    // is there to protect.
    for (const key of localSessionEnvKeys(cfg)) delete env[key];
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
  //
  // Deducing it from the daemon cap only works when a cap is set. With
  // OLLAMA_CONTEXT_LENGTH unset — the out-of-the-box state — there was nothing to
  // clamp against, so the advertised maximum went straight into the config and
  // the fitter spent every request believing in room the daemon would never give
  // it. So ask instead of deducing: load the model and read back what /api/ps
  // says was actually allocated.
  const detected = detectOllama();
  const daemonCap = Number(detected.launchctlValue || detected.envValue || 0) || null;
  const modelMax = info.contextLength || null;
  // `--context` with no value parses as `true`, and Number(true) is 1.
  const asked = Number(flags.context) > 0 ? Number(flags.context) : null;
  const deduced = Number(
    asked
    || Math.min(...[modelMax, daemonCap].filter(Boolean))
    || cfg.models[cfg.defaultModel]?.maxContext
    || 32768,
  );

  let measured = null;
  if (backend.kind === 'ollama' && !flags['no-measure']) {
    out(`  ${C.dim(`loading ${match.name} to measure the context Ollama really allocates…`)}`);
    measured = await measureAllocatedContext(backend, match.name, deduced).catch(() => null);
  }

  // An explicit --context is the user overriding us, so it still wins; the
  // measurement then serves as a warning rather than a veto.
  const window = asked || measured || deduced;
  const small = flags.small || match.name;
  const smallInfo = small === match.name ? info : await describe(small);
  const smallWindow = small === match.name
    ? window
    : asked || Math.min(...[smallInfo.contextLength, daemonCap, window].filter(Boolean)) || window;

  const patch = {
    models: {
      blaude: { backend: backendName, model: match.name, maxContext: window, maxOutput: 8192 },
      'blaude-small': {
        backend: backendName,
        model: small,
        maxContext: smallWindow,
        maxOutput: 4096,
      },
    },
    defaultModel: 'blaude',
  };
  const file = writeConfigPatch(patch);

  out('');
  out(`  ${C.green('✓')} Blaude now serves ${C.cyan(match.name)} ${C.dim(`(${(match.size / 1e9).toFixed(1)} GB, ${match.details?.quantization_level || '?'})`)}`);
  const capNote = asked
    ? '(you set it)'
    : measured
      ? `(measured from /api/ps${modelMax && measured < modelMax ? `; this model can do ${modelMax.toLocaleString()}` : ''})`
      : daemonCap && modelMax && daemonCap < modelMax
        ? `(daemon cap; this model can do ${modelMax.toLocaleString()})`
        : modelMax ? `(the model's advertised maximum — unverified)` : '(from your config)';
  out(`  context      ${window.toLocaleString()} tokens ${C.dim(capNote)}`);
  const target = asked || deduced;
  if (measured && measured < target) {
    out(`  ${C.yellow('!')} Ollama allocated ${measured.toLocaleString()} tokens, not the ${target.toLocaleString()} asked for — it sizes`);
    out(`    ${C.dim('context to fit memory, and truncates the overflow in silence.')}`);
    out(`    ${C.dim('Unload other models, or raise the cap:')} ${C.cyan(`blaude ollama context ${target} --apply`)}`);
  } else if (!measured) {
    out(`  ${C.yellow('!')} Could not measure what Ollama really allocates, so this figure is unverified.`);
    out(`    ${C.dim('Confirm it before trusting it:')} ${C.cyan('blaude doctor')}`);
  }
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

/**
 * Load a model and ask Ollama what context it actually allocated.
 *
 * The advertised maximum is a ceiling Ollama will not hand you: it clamps to
 * OLLAMA_CONTEXT_LENGTH and then again to free memory, and it truncates the
 * overflow from the FRONT rather than erroring — taking the system prompt and
 * tool definitions with it. One throwaway generation turns a guess into a
 * measurement, and the model has to load for the next real request anyway.
 */
async function measureAllocatedContext(backend, model, numCtx, { timeoutMs = 240_000 } = {}) {
  const base = backend.baseUrl.replace(/\/+$/, '');
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(backend.apiKey ? { authorization: `Bearer ${backend.apiKey}` } : {}) },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
      think: false,
      options: { num_predict: 1, ...(numCtx ? { num_ctx: numCtx } : {}) },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  await res.json();
  const loaded = await loadedContexts(base);
  const hit = loaded.find((m) => m.name === model || m.name?.startsWith(model));
  return hit?.contextLength ?? null;
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
  const cfg = await scopeConfigToAccount(loadConfig(), { quiet: true });
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
  out(`  ${C.dim(`account: ${describeAccount(cfg.account)}`)}`);
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

  // Hoisted: this reads every transcript on disk with no mtime filter, and it was
  // doing so once per window.
  let limitHits = null;
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
      if (!limitHits) limitHits = await findLimitEvents({});
      const hits = limitHits;
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
  const cfg = loadConfig();
  const mode = positional[0] ? resolveModeName(positional[0]) : positional[0];
  if (!mode) {
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
    out(`  ${C.dim('blaude mode claude-first --floor main=35,audit=5  per-purpose floors')}`);
    out(`  ${C.dim('blaude mode claude-first --floor audit=never      never spend Claude on that purpose')}`);
    out('');
    return;
  }
  if (!MODES[mode]) throw new Error(`Unknown mode "${mode}". Known: ${Object.keys(MODES).join(', ')}`);

  let floors = null;
  if (flags.floor) {
    floors = {};
    const spec = String(flags.floor);
    if (spec.includes('=')) {
      // Parsed here rather than stripped, so the config file records a settled
      // fraction and `--floor audit=1%` cannot be flattened into the sentinel.
      for (const pair of spec.split(',')) {
        const [k, v] = pair.split('=');
        floors[k.trim()] = parseFloor(v);
      }
    } else {
      const v = parseFloor(spec);
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

  // A mode that intends Claude to do the work cannot deliver it in every launch
  // configuration. Say so here rather than letting it look like it is working.
  const wantsClaudeForWork = (effective.floors?.main ?? NEVER) < NEVER;
  const relayOnly = effective.cloudTransport === 'cli';
  const inPath = cfg.launch === 'gateway';

  if (wantsClaudeForWork && inPath && relayOnly) {
    out('');
    out(`  ${C.yellow('!')} This combination cannot send ordinary turns to Claude.`);
    out(`    ${C.dim(`mode ${mode} wants Claude for main turns, but launch=gateway keeps Blaude in the`)}`);
    out(`    ${C.dim('request path, and reaching Claude from there means relaying through the CLI —')}`);
    out(`    ${C.dim('~2x the tokens and ~4x the wall clock of a native session, and it did not')}`);
    out(`    ${C.dim('finish reliably. Ordinary turns stay local.')}`);
    out('');
    out(`    For Claude to actually do the work:  ${C.cyan('blaude route auto')}`);
    out(`    ${C.dim('(then `blaude guard on` so a native session still stops at your floor)')}`);
  }

  const meterNow = new AllowanceMeter({ policy: effective });
  await meterNow.refresh(true).catch(() => {});
  const tight = meterNow.tightest();
  if (wantsClaudeForWork && tight && tight.fractionRemaining <= (effective.floors.main ?? 0)) {
    out('');
    out(`  ${C.yellow('!')} Right now this behaves like local-only: ${pct(tight.fractionRemaining)} of your`);
    out(`    ${tight.name} allowance is left, under the ${pct(effective.floors.main)} floor for ordinary turns.`);
    if (tight.resetsAt) out(`    ${C.dim(`Resets ${tight.resetsAt}.`)}`);
  }
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
    candidates.push(['claude-audits', buildPolicy(cfg, 'claude-audits')]);
    candidates.push(['claude-first @ 20%', buildPolicy(cfg, 'claude-first', '20')]);
    candidates.push(['claude-first @ 10%', buildPolicy(cfg, 'claude-first', '10')]);
    candidates.push(['claude-first @ 0%', buildPolicy(cfg, 'claude-first', '0')]);
    candidates.push(['claude-first @ 35%', buildPolicy(cfg, 'claude-first', '35')]);
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
    const v = parseFloor(floor);
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

    // A Blaude-hosted session routes through the gateway already. Match the
    // account's own port as well as the base one, since the two differ now.
    const cfg = loadConfig();
    const account = cachedAccount();
    const ourPort = portForAccount(cfg.port, account);
    const base = process.env.ANTHROPIC_BASE_URL || '';
    if (base.includes(`:${ourPort}`) || base.includes(`:${cfg.port}`) || process.env.BLAUDE_SESSION === 'local') emit(null);

    // No identity, no guard. The cache is per account, and blocking a prompt on
    // another account's exhausted allowance is a worse failure than not guarding
    // this one — the detached refresh will have written our file by next prompt.
    if (!account) emit(null);

    const policy = normalizePolicy(cfg.policy || {});
    const report = await readUsageCached({ ttlMs: Number(flags.ttl || 60) * 1000, accountKey: account.key });
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
    const account = await readAccount().catch(() => null);
    const report = await readUsageCommand();
    writeUsageCache(report, account?.key ?? null);
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

  // A search is a capability gap, not ordinary work: `blaude search` exists only
  // because WebSearch is withheld from local models, and it is a coarse one-shot
  // over the transport that measured fine. Gating it on the `tools` floor pinned
  // it to NEVER in every mode but claude-first, so the feature that fills the
  // hole was itself switched off by default. It gets capability routing's own
  // bounded floor instead — and local-only still means local-only.
  const searchFloor = policy.mode === 'local-only'
    ? NEVER
    : (policy.capabilityRouting?.floor ?? 0.05);
  await assertAllowance('tools', {
    force: Boolean(flags.force),
    label: 'A web search',
    floor: searchFloor,
    remedy: `lower policy.capabilityRouting.floor in ${CONFIG_FILE()}`,
  });
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
  const cfg = loadConfig();
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
  const tokens = Number(String(value).replace(/[_,]/g, '').replace(/k$/i, '000'));
  if (!Number.isFinite(tokens) || tokens < 2048) throw new Error('Give a context size in tokens, e.g. `blaude ollama context 200000`');

  // Work out whether that context can actually be held, from the model's own
  // architecture and this machine's memory, rather than finding out by swapping.
  const backendName = cfg.models[cfg.defaultModel]?.backend || 'ollama';
  const backend = cfg.backends[backendName];
  const modelName = cfg.models[cfg.defaultModel]?.model;
  let profile = null;
  let memPlan = null;
  let weightsBytes = 0;
  try {
    profile = await modelMemoryProfile(backend.baseUrl, modelName);
    const tags = await fetch(`${backend.baseUrl.replace(/\/+$/, '')}/api/tags`, { signal: AbortSignal.timeout(8000) }).then((r) => r.json());
    weightsBytes = (tags.models || []).find((m) => m.name === modelName)?.size || 0;
    const mem = availableMemory();
    // The model being reconfigured is about to be unloaded, so its current
    // residency counts as available — otherwise raising a context looks
    // impossible purely because the old allocation is still held.
    const resident = (await loadedContexts(backend.baseUrl).catch(() => []))
      .filter((m) => m.name === modelName)
      .reduce((n, m) => n + (m.sizeVram || 0), 0);
    memPlan = planMemory({
      profile, tokens, weightsBytes,
      totalBytes: totalmem(),
      availableBytes: mem.availableBytes + resident,
    });
    memPlan.mem = mem;
    memPlan.reclaimable = resident;
  } catch (err) {
    out(`  ${C.yellow('!')} could not inspect ${modelName} (${err.message}) — proceeding without a memory check`);
  }

  out('');
  out(`  ${C.bold(`Context cap -> ${tokens.toLocaleString()} tokens`)} ${C.dim(`for ${modelName}`)}`);

  if (memPlan?.exceedsModelMax) {
    out('');
    out(`  ${C.red('✗')} ${modelName} tops out at ${profile.modelMaxContext.toLocaleString()} tokens — that is the`);
    out(`    model's own architecture, not an Ollama setting, so no configuration reaches`);
    out(`    ${tokens.toLocaleString()}. Pick a model with a longer context, or ask for`);
    out(`    ${C.cyan(`blaude ollama context ${profile.modelMaxContext}`)}.`);
    out('');
    return;
  }

  let kvType = flags.kv || null;
  if (memPlan) {
    const perTok = profile.bytesPerTokenFp16 / 1024;
    out(`  ${C.dim(`${profile.layers} layers · ${profile.kvHeads} kv heads · ${perTok.toFixed(0)} KB/token at f16 · weights ${(weightsBytes / 1e9).toFixed(1)} GB`)}`);
    out(`  ${C.dim(`memory available: ${(memPlan.headroom / 1e9).toFixed(1)} GB of ${(totalmem() / 1e9).toFixed(0)} GB total`
      + (memPlan.reclaimable ? ` (includes ${(memPlan.reclaimable / 1e9).toFixed(1)} GB reclaimed from the current load)` : ''))}`);
    if (memPlan.mem?.alreadySwapping) {
      out(`  ${C.yellow('!')} this machine is already using ${(memPlan.mem.swapUsedBytes / 1e9).toFixed(1)} GB of swap — close things before allocating more`);
    }
    out('');
    for (const o of memPlan.options) {
      const label = `KV ${o.type}`.padEnd(9);
      const line = `${label} cache ${(o.kvBytes / 1e9).toFixed(1).padStart(5)} GB  resident ${(o.totalBytes / 1e9).toFixed(1).padStart(5)} GB`;
      out(`    ${o.fits ? C.green('✓') : C.red('✗')} ${line}${o.fits ? '' : C.dim('  — would not leave enough for the system')}`);
    }
    if (!kvType) kvType = memPlan.recommended?.type ?? null;
    out('');
    if (!kvType) {
      out(`  ${C.red('✗')} ${tokens.toLocaleString()} tokens does not fit at any KV cache type on this machine.`);
      out(`    ${C.dim('Try a smaller context, or a smaller/more heavily quantised model.')}`);
      out('');
      return;
    }
    out(`  using ${C.cyan(`KV ${kvType}`)}${kvType !== 'f16' ? C.dim(' (quantised cache — needs flash attention, set below)') : ''}`);
    if (kvType === 'q4_0') out(`  ${C.yellow('!')} q4_0 is a lossy cache; q8_0 is closer to lossless if it fits.`);
  }

  const plan = planContextChange(tokens, detected, { kvType });
  out('');
  out(`  ${C.dim('A bigger context is allocated up front, so it costs memory even when your')}`);
  out(`  ${C.dim('prompts are short. It does not make short prompts slower.')}`);
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
  writeConfigPatch({ models: { [cfg.defaultModel]: { maxContext: plan.value } } });
  out(`  ${C.green('✓')} recorded maxContext ${plan.value.toLocaleString()} for ${cfg.defaultModel}`);
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
      mode: 'claude-audits',
      limits: { session: { period: '5h', amount: 0 }, weekly: { period: 'week', amount: 0 } },
      // "never" rather than 1: both mean the same thing, but only one of them
      // reads correctly next to "audit": "5%".
      floors: { main: 'never', tools: 'never', audit: '5%', background: 'never' },
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
  ${C.bold('blaude update')}               install the latest release ${C.dim('(--check, --rollback)')}
  ${C.bold('blaude search')} "query"      real web search for a local model, via Claude
  ${C.bold('blaude serve')}              run the gateway in the foreground
  ${C.bold('blaude simulate')}           try policies against your real history ${C.dim('(--days 7 --verbose)')}
  ${C.bold('blaude stats')}              what Blaude has served ${C.dim('(--json)')}
  ${C.bold('blaude init')}               write a config file ${C.dim('(--local)')}

  ${C.dim('modes:')} ${Object.keys(MODES).join(', ')}
  ${C.dim('config:')} ${CONFIG_FILE()}
`);
}


/**
 * Install a newer Blaude, or step back to the one that worked.
 *
 * The install kind decides what is even safe to do. A release tree under
 * ~/.blaude/versions is ours to swap; a git checkout may hold your uncommitted
 * work, so it is never overwritten and the answer is always "git pull". Nothing
 * installs without being asked for: `--check` only reports, and the background
 * refresh that keeps the cache warm touches nothing but the cache.
 */
export async function cmdUpdate(argv) {
  const { flags, positional } = parseFlags(argv);
  const cfg = await loadConfig();
  const repo = updateRepo(cfg);

  // The detached refresh spawned by checkForUpdate({block:false}) lands here.
  // It exists to warm the cache and must stay silent.
  if (flags['refresh-cache']) {
    const { release } = await fetchLatestRelease({ repo }).catch(() => ({ release: null }));
    writeUpdateCache({ repo, latest: release?.version ?? null, tag: release?.tag ?? null, notes: release?.notes ?? '' });
    return;
  }

  if (flags.rollback) {
    const to = typeof flags.rollback === 'string' ? flags.rollback : (positional[0] || null);
    try {
      const { version, from } = rollback(to);
      out(`${C.green('✓')} rolled back to ${C.bold(version)}${from ? C.dim(` (from ${from})`) : ''}`);
    } catch (err) {
      out(`${C.red('✗')} ${err.message}`);
      process.exitCode = 1;
    }
    return;
  }

  const install = describeInstall();
  out('');
  out(`  ${C.bold('blaude')} ${VERSION}  ${C.dim(`(${install.kind} install at ${install.root})`)}`);

  const status = await checkForUpdate({ repo }).catch((err) => ({ error: err.message }));
  if (status?.error) {
    out(`  ${C.red('✗')} could not reach ${repo}: ${status.error}`);
    out('');
    process.exitCode = 1;
    return;
  }
  if (!status?.latest) {
    out(`  ${C.dim(`no releases published on ${repo} yet`)}`);
    out('');
    return;
  }
  if (!status.newer) {
    out(`  ${C.green('✓')} already on the latest release ${C.dim(`(${status.latest})`)}`);
    const have = installedVersions();
    if (have.length > 1) out(`  ${C.dim(`installed: ${have.join(', ')}`)}`);
    out('');
    return;
  }

  out(`  ${C.yellow('→')} ${C.bold(status.latest)} is available ${C.dim(`(you have ${status.current})`)}`);
  if (flags.check) { out(''); return; }

  // A checkout is the user's own working tree; overwriting it would destroy
  // uncommitted work, so say what to run and stop.
  if (install.kind === 'git') {
    out(`  ${C.dim('this is a git checkout — update it with:')}  git -C ${install.root} pull`);
    out('');
    return;
  }
  if (install.kind !== 'release') {
    out(`  ${C.dim('this copy is not managed by blaude (npm link, or copied by hand);')}`);
    out(`  ${C.dim('reinstall with:')}  curl -fsSL https://raw.githubusercontent.com/${repo}/main/install.sh | sh`);
    out('');
    return;
  }

  const { release } = await fetchLatestRelease({ repo });
  try {
    await applyUpdate({ repo, release, onStep: (m) => out(`  ${C.dim(m)}`) });
    out(`  ${C.green('✓')} updated to ${C.bold(release.version)} ${C.dim('— blaude update --rollback undoes this')}`);
  } catch (err) {
    out(`  ${C.red('✗')} update failed: ${err.message}`);
    out(`  ${C.dim('your existing install was left untouched')}`);
    process.exitCode = 1;
  }
  out('');
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
  update: cmdUpdate,
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
  // Read, never spelled out: a literal here is what version.mjs exists to stop.
  // It survived that consolidation and quietly reported 0.1.0 forever, which
  // also meant release.sh's "does the tarball report its version" gate could
  // never pass for any release after the first.
  if (first === '--version' || first === '-v') return out(`blaude ${VERSION}`);

  // Every command below reads `loadConfig()`, and the port it returns decides
  // which gateway this terminal talks to. `hook` is excluded because it runs
  // before every prompt and resolves its account from cache instead — it cannot
  // afford the `claude auth status` spawn a cold bind would cost.
  if (first !== 'hook') await bindAccountPort();

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
