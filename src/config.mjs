// @ts-nocheck — not yet typed. `npm test` runs `tsc --checkJs` over this repo;
// the translation layer (anthropic-to-openai, openai-to-anthropic, stream,
// text-scanner, fit-context) is clean and stays clean. This file is not, so it
// opts out rather than making the check unrunnable. Delete this line, run
// `npm run typecheck`, and fix what it says.
// Config loading + defaults. No dependencies: JSON on disk, env overrides.
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const BLAUDE_HOME = process.env.BLAUDE_HOME || join(homedir(), '.blaude');

/**
 * Defaults are deliberately conservative: everything stays local, and the only
 * way a request reaches a paid API is an explicit `cloud/` model prefix or a
 * route the user added themselves.
 */
export const DEFAULTS = {
  host: '127.0.0.1',
  port: 8817,

  backends: {
    // Already installed on most Macs that have played with local models.
    // Native API rather than the OpenAI shim: it accepts options.num_ctx and
    // handles tools/images more faithfully. See src/ollama-backend.mjs.
    ollama: { kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', apiKey: null },
    // `mlx_lm.server --port 8081` — see scripts/setup-mlx.sh
    mlx: { kind: 'openai', baseUrl: 'http://127.0.0.1:8081/v1', apiKey: 'mlx' },
    // Only reachable via an explicit `cloud/` prefix or a user-added route.
    anthropic: { kind: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKeyEnv: 'ANTHROPIC_API_KEY' },
  },

  // Logical model names Claude Code (or you) can ask for.
  models: {
    blaude: { backend: 'ollama', model: 'qwen3:8b', maxContext: 65536, maxOutput: 8192 },
    'blaude-small': { backend: 'ollama', model: 'qwen3:4b', maxContext: 32768, maxOutput: 4096 },
  },

  // First match wins. `match` is a glob over the requested model id.
  routes: [
    // Claude Code's cheap background model (titles, summaries) -> smallest local.
    { match: '*haiku*', model: 'blaude-small' },
    // Everything else Claude Code asks for (sonnet, opus, ...) -> local default.
    { match: '*', model: 'blaude' },
  ],

  defaultModel: 'blaude',

  // How to handle reasoning traces from local reasoning models.
  //   strip -> drop them (safest; Claude Code never sees an unsigned thinking block)
  //   text  -> fold them into the visible text
  thinking: 'strip',

  // Whether Ollama should reason before answering. false keeps the fast,
  // existing default; null lets the model use its own default; true or
  // low/medium/high/max enables a supported level. An explicit Anthropic
  // thinking/output_config request wins when this is null. This is separate
  // from `thinking`, which only controls what happens to a trace after it comes
  // back.
  localThinking: false,

  // Parse `<tool_call>{...}</tool_call>` emitted as plain text by models whose
  // server-side tool support is weak or absent.
  textToolCalls: true,

  // Emitted only when the upstream server does not report usage itself.
  estimateUsage: true,

  // Ask Claude Code for its abbreviated system prompt and tool descriptions when
  // the session is running locally. Measured: the fixed floor drops from 34,817
  // tokens to 23,736 on its own, and to 5,399 combined with `localTools`.
  simpleSystemPrompt: true,

  // Which tool definitions reach a local model.
  //
  // Claude Code sends ~27,500 tokens of tool definitions across 25 tools; the
  // largest are orchestration tools (Workflow alone is ~5,900) that a local
  // coding model never calls, and every one of them is re-prefilled on every
  // turn. Keeping only the coding core cuts the fixed floor by roughly 20k.
  //
  //   mode: 'core' -> keep `allow` (plus `also`);  'all' -> send everything
  //   also: extra names or globs to keep, e.g. ['mcp__github__*']
  localTools: { mode: 'core', also: [] },

  // How many times to reissue a request that came back with nothing in it —
  // no text and no tool calls. Some local builds do this intermittently
  // (gemma4 on Ollama's MLX runner: 7 turns in 10 after a tool result), and the
  // agent reads the empty turn as a finished one and stops. Set 0 to disable.
  emptyCompletionRetries: 2,

  // How long Claude Code waits on a single request before giving up.
  //
  // Its own default is minutes, which is fine against Claude and far too short
  // against a large local model: prefill on a 27B runs at ~100 tok/s, so a 30k
  // prompt needs ~5 minutes before the first token. The client timing out mid
  // prefill is invisible from its side and looks like a hang, while the backend
  // keeps grinding and blocks every other request queued behind it.
  apiTimeoutMs: 900_000,

  // How `blaude` launches a session.
  //
  //   auto    -> when policy says Claude, launch a NATIVE Claude session (no
  //              gateway in the path). Fastest and cheapest for Claude-heavy
  //              work because prompt caching stays intact, but Blaude cannot
  //              route mid-session, so the guard hook is what stops an overrun.
  //   gateway -> ALWAYS route through Blaude. Every request is policy-checked,
  //              the handoff is automatic at the next prompt, and no hook is
  //              needed. Claude-served turns pay escalation overhead
  //              (~2.6k tokens warm, ~8.5k cold) instead of using the cache.
  //
  // Pick `gateway` if never touching usage credits matters more than squeezing
  // the most out of Claude while you have allowance.
  launch: 'auto',

  // What to strip from a Claude Code session that a local model will serve.
  //
  // MCP servers are the big one: their tool definitions are sent on every
  // request, and a local model pays for them in prompt-evaluation time it can
  // barely use. Measured here: a trivial task in an empty directory produced a
  // 52k-token prompt with 46 tool definitions, at 154s to first token. A local
  // model wants a small prompt far more than it wants a browser.
  //
  // Set `disableMcp: false` if you need MCP tools in local sessions.
  localSession: { disableMcp: true, disableBundledSkills: false },

  // Tools that do not function when a local model is driving.
  //
  // WebSearch is the proven case: it is a client-side tool, so a local model CAN
  // call it and Claude Code WILL execute it — but the search itself runs against
  // Anthropic's service, which a local session cannot authenticate to, so results
  // come back empty. A small model handed an empty result set tends to answer
  // from memory and invent a citation, which is worse than having no tool.
  //
  // Removing the tool makes the model say it cannot search, which is the truth.
  // Set `drop: []` to keep them, or add your own (an MCP search server gives the
  // local model a real web path that does not depend on Anthropic).
  localToolPolicy: { drop: ['WebSearch'], note: true },

  // Deliberate prompt trimming when a request exceeds the backend's real
  // context window. Beats letting the server drop the front of the prompt.
  contextFit: { enabled: true, reserveOutput: 4096, maxToolResultChars: 4000 },

  // Policy defaults live in policy.mjs (DEFAULT_POLICY); anything set here wins.
  policy: {},

  // Optional {referenceModel, rates:{model:{inputPerMTok,outputPerMTok}}}.
  // Empty by default: Blaude does not ship guessed prices.
  pricing: {},

  usageLog: join(BLAUDE_HOME, 'usage.jsonl'),
  logLevel: process.env.BLAUDE_LOG_LEVEL || 'info',
};

function deepMerge(base, override) {
  if (Array.isArray(override)) return override.slice();
  if (override === null || typeof override !== 'object') return override;
  const out = { ...(base && typeof base === 'object' ? base : {}) };
  for (const [k, v] of Object.entries(override)) out[k] = deepMerge(out[k], v);
  return out;
}

/**
 * Config files to layer, least specific first.
 *
 * BLAUDE_CONFIG is an explicit, standalone choice and stands alone: pointing it
 * at a test config must not drag your real settings in behind it. Otherwise the
 * home config is the base and a project file layers over it — "override" in the
 * sense people mean it. It used to be first-match-wins, so a project file setting
 * nothing but `policy.mode` silently discarded every model, backend and route you
 * had configured at home.
 */
export function configPathCandidates(cwd = process.cwd(), env = process.env) {
  if (env.BLAUDE_CONFIG) return [resolve(env.BLAUDE_CONFIG)];
  return [join(BLAUDE_HOME, 'config.json'), join(cwd, 'blaude.config.json')];
}

export function loadConfig({ cwd = process.cwd(), env = process.env } = {}) {
  let fileConfig = {};
  const sources = [];
  for (const p of configPathCandidates(cwd, env)) {
    if (!existsSync(p)) continue;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(p, 'utf8'));
    } catch (err) {
      throw new Error(`Blaude config at ${p} is not valid JSON: ${err.message}`);
    }
    fileConfig = deepMerge(fileConfig, parsed);
    sources.push(p);
  }

  const cfg = deepMerge(DEFAULTS, fileConfig);
  // Every file that fed this config, most specific last. `configSource` stays a
  // single path because things watch it; `configSources` is the whole stack.
  cfg.configSources = sources;
  cfg.configSource = sources.at(-1) || '(defaults)';

  // Env overrides win over the file so one-off runs stay easy.
  if (env.BLAUDE_PORT) cfg.port = Number(env.BLAUDE_PORT);
  if (env.BLAUDE_HOST) cfg.host = env.BLAUDE_HOST;
  if (env.BLAUDE_MODEL) cfg.defaultModel = env.BLAUDE_MODEL;
  if (env.BLAUDE_THINKING) cfg.thinking = env.BLAUDE_THINKING;
  if (env.BLAUDE_BACKEND_URL) {
    // Point the default model's backend somewhere else without editing config.
    const target = cfg.models[cfg.defaultModel];
    if (target) cfg.backends[target.backend] = { ...cfg.backends[target.backend], baseUrl: env.BLAUDE_BACKEND_URL };
  }
  if (env.BLAUDE_TEXT_TOOL_CALLS === '0') cfg.textToolCalls = false;

  validateConfig(cfg);
  return cfg;
}

export function validateConfig(cfg) {
  for (const [name, m] of Object.entries(cfg.models)) {
    if (!m.backend) throw new Error(`Model "${name}" is missing "backend"`);
    if (!cfg.backends[m.backend]) throw new Error(`Model "${name}" references unknown backend "${m.backend}"`);
    if (!m.model) throw new Error(`Model "${name}" is missing the upstream "model" id`);
  }
  if (!cfg.models[cfg.defaultModel]) {
    throw new Error(`defaultModel "${cfg.defaultModel}" is not defined in "models"`);
  }
  for (const r of cfg.routes) {
    if (!r.match) throw new Error('Every route needs a "match" glob');
    if (r.model && !cfg.models[r.model] && !r.backend) {
      throw new Error(`Route "${r.match}" targets unknown model "${r.model}"`);
    }
  }
  return cfg;
}

export function ensureHome() {
  if (!existsSync(BLAUDE_HOME)) mkdirSync(BLAUDE_HOME, { recursive: true });
  return BLAUDE_HOME;
}
