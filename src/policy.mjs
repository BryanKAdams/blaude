// @ts-nocheck — not yet typed. `npm test` runs `tsc --checkJs` over this repo;
// the translation layer (anthropic-to-openai, openai-to-anthropic, stream,
// text-scanner, fit-context) is clean and stays clean. This file is not, so it
// opts out rather than making the check unrunnable. Delete this line, run
// `npm run typecheck`, and fix what it says.
// Blaude's policy engine.
//
// The question it answers, per request: does this deserve Claude, or should the
// local model take it?
//
// Budgets are expressed the way you actually think about a Claude subscription:
// as REMAINING ALLOWANCE across the two windows Anthropic meters you on — the
// rolling session window and the week. Each purpose gets a FLOOR: the fraction
// of allowance that must still be left for that purpose to be worth spending
// Claude on.
//
//   floors: { main: 0.20, audit: 0.05 }
//   -> ordinary work uses Claude while >20% of the allowance remains
//   -> audits keep using Claude down to the last 5%
//
// Whichever window is tighter wins ("either the weekly or session allotment").
//
// Scope note, stated plainly: Anthropic does not expose your true remaining
// quota to a third-party tool, and there is no non-interactive `claude usage`.
// Blaude measures REAL observed consumption from Claude Code's own transcripts
// and compares it against allotments you calibrate from your own history
// (`blaude calibrate`). The consumption is real; the ceiling is your estimate.

import { claudeUsageReport, DEFAULT_WEIGHTS } from './claude-usage.mjs';
import { readUsageCommand } from './usage-command.mjs';

export const PURPOSES = ['main', 'tools', 'audit', 'background'];

export const PERIOD_MS = {
  hour: 3_600_000,
  '5h': 5 * 3_600_000,
  day: 24 * 3_600_000,
  week: 7 * 24 * 3_600_000,
  month: 30 * 24 * 3_600_000,
};

/** A floor of 1 means "never" — no allowance level is ever above 100% remaining. */
export const NEVER = 1;

export const MODES = {
  'local-only': {
    description: 'Everything local, always. Claude is unreachable, even for audits.',
    floors: { main: NEVER, tools: NEVER, audit: NEVER, background: NEVER },
  },
  // Named for what Claude's job is, because the old name ("local-first") read as
  // "prefer local, fall back to Claude automatically", which is not what it does:
  // every turn is local, and Claude is reachable only for review.
  'claude-audits': {
    description: 'Local does all the work; Claude is only used to review it.',
    floors: { main: NEVER, tools: NEVER, audit: 0.05, background: NEVER },
  },
  'claude-first': {
    description: 'Claude does the work until your allowance runs low, then local takes over.',
    floors: { main: 0.2, tools: 0.2, audit: 0.05, background: NEVER },
  },
  // There is no "split" mode — "Claude for thinking, local for the grind" is not
  // deliverable. With Blaude in the request path, ordinary turns never reach
  // Claude at all (the relay lost on every measured axis), so a split collapses
  // to local-only. Out of the path, the session is native and Claude does the
  // grind too, so it collapses to claude-first. It was the same as claude-first
  // in both directions while describing something neither one does.
};

/** Old names kept working, so existing configs do not break. */
export const MODE_ALIASES = {
  'local-first': 'claude-audits',
  // Kept resolving so existing configs load; `--floor` overrides still apply.
  split: 'claude-first',
};

export function resolveModeName(name) {
  return MODE_ALIASES[name] || name;
}

/**
 * Read a floor the way people write them: 0.2, 20, "20%", "never", null.
 *
 * The `%` carries meaning and must survive to here. A bare number above 1 reads
 * as a percentage and a bare number at or below 1 reads as a fraction, which
 * leaves no bare spelling for one percent — `1` has to keep meaning NEVER,
 * because that is what every mode preset and every config `blaude init` writes
 * uses. So "1%" is the spelling for one percent, and it is honoured as one
 * percent instead of collapsing onto the sentinel and silently switching Claude
 * off. Anything that means "never" can also say so in words.
 */
export function parseFloor(value) {
  if (value == null || value === false) return NEVER;
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase();
    if (s === 'never' || s === 'local' || s === 'off') return NEVER;
    if (s.endsWith('%')) {
      const percent = Number(s.slice(0, -1));
      if (!Number.isFinite(percent)) throw new Error(`"${value}" is not a percentage`);
      return percent / 100;
    }
    const n = Number(s);
    if (!Number.isFinite(n)) throw new Error(`"${value}" is not a number, a percentage, or "never"`);
    return n > 1 ? n / 100 : n;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`expected a number, a percentage or "never", got ${JSON.stringify(value)}`);
  }
  return value > 1 ? value / 100 : value;
}

export const DEFAULT_POLICY = {
  mode: 'claude-audits',

  // Allotments per window. `amount` 0 means "unknown" -> that window is ignored
  // until you run `blaude calibrate`.
  limits: {
    session: { period: '5h', amount: 0 },
    weekly: { period: 'week', amount: 0 },
  },

  // Per-purpose floors on remaining allowance. null = inherit from the mode.
  floors: null,

  unit: 'tokens',              // tokens (weighted) | requests
  weights: DEFAULT_WEIGHTS,

  // Where allowance state comes from:
  //   usage-command -> `claude -p "/usage"`: exact percentages, free, no tokens
  //   claude-code   -> inferred from Claude Code transcripts + calibrated limits
  //   gateway       -> only cloud traffic Blaude itself forwarded
  // usage-command falls back to claude-code automatically if it cannot be read.
  source: 'usage-command',

  onExhausted: 'local',        // local | error

  // Handoff behaviour. Re-caching a long conversation on Claude is expensive, so
  // never flip destination in the middle of a turn: finish the turn wherever it
  // started, and switch on the next user prompt. That transition is free —
  // Claude is simply not called again, and the local model re-reads the context
  // for nothing.
  handoff: {
    stickyTurns: true,
    // Ignore stickiness below this much remaining allowance, so a runaway turn
    // cannot blow through the last of your allotment.
    hardStopFraction: 0.02,
    // Tell the local model it is taking over, so it does not act confused.
    announce: true,
  },

  // Send a request to Claude when the local model *cannot* honour it — most often
  // because the local backend has no working tool-calling support.
  //
  // This gets its own floor rather than the purpose's: the point is that the
  // request is otherwise unservable, so it should still reach Claude after
  // ordinary work has fallen back. Bounded so it cannot drain the last of the
  // allowance, and never active in local-only mode.
  capabilityRouting: { toolsRequireClaude: false, floor: 0.05 },

  // How a cloud-destined request is served.
  //   cli -> the official `claude` CLI, i.e. your subscription (default)
  //   api -> api.anthropic.com with ANTHROPIC_API_KEY, i.e. metered billing
  cloudTransport: 'cli',

  // There is deliberately no switch to relay ordinary agent turns through
  // `claude -p`. It was measured against a native session and lost on every
  // axis: ~2x the Claude tokens, ~4x the wall clock (the outer conversation
  // cannot reuse the prompt cache), and it did not reliably finish the task — a
  // benchmark turn came back empty where the same task succeeded natively. An
  // option nobody should ever enable is not an option, it is a trap.
  //
  // Coarse one-shots over the same transport (audits, `blaude search`) measured
  // fine and are unaffected. For Claude to do ordinary work, take Blaude out of
  // the request path: `blaude route auto`.

  cloudModels: { main: 'sonnet', tools: 'haiku', audit: 'opus', background: 'haiku' },
  localModels: { main: null, tools: null, audit: null, background: 'blaude-small' },
};

// ---------------------------------------------------------------------------
// Purpose classification, from observable request features only.
// ---------------------------------------------------------------------------

export function classifyRequest(body, { requestedModel = '' } = {}) {
  const model = String(requestedModel || body?.model || '');

  if (/^audit\//i.test(model)) return 'audit';
  const tagged = body?.metadata?.blaude_purpose;
  if (tagged && PURPOSES.includes(tagged)) return tagged;
  const prefixed = /^(main|tools|background)\//i.exec(model);
  if (prefixed) return prefixed[1].toLowerCase();

  if (/haiku/i.test(model)) return 'background';

  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const last = messages[messages.length - 1];
  if (last?.role === 'user' && Array.isArray(last.content)
      && last.content.some((b) => b?.type === 'tool_result')) return 'tools';
  if (last?.role === 'assistant') return 'tools';

  return 'main';
}

export function stripPurposePrefix(model) {
  return String(model ?? '').replace(/^(audit|main|tools|background|local|blaude|cloud|anthropic)\//i, '');
}

// ---------------------------------------------------------------------------
// Policy compilation
// ---------------------------------------------------------------------------

export function normalizePolicy(input = {}) {
  const policy = {
    ...DEFAULT_POLICY,
    ...input,
    limits: { ...DEFAULT_POLICY.limits, ...(input.limits || {}) },
    capabilityRouting: { ...DEFAULT_POLICY.capabilityRouting, ...(input.capabilityRouting || {}) },
    cloudModels: { ...DEFAULT_POLICY.cloudModels, ...(input.cloudModels || {}) },
    localModels: { ...DEFAULT_POLICY.localModels, ...(input.localModels || {}) },
  };
  policy.weights = { ...DEFAULT_WEIGHTS, ...(input.weights || {}) };

  policy.mode = resolveModeName(policy.mode);
  const mode = MODES[policy.mode];
  if (!mode) {
    throw new Error(
      `Unknown Blaude mode "${policy.mode}". Known: ${Object.keys(MODES).join(', ')}` +
      ` (aliases: ${Object.keys(MODE_ALIASES).join(', ')})`,
    );
  }

  const floors = { ...mode.floors, ...(input.floors || {}) };
  for (const [purpose, value] of Object.entries(floors)) {
    if (!PURPOSES.includes(purpose)) {
      throw new Error(`Floor set for unknown purpose "${purpose}". Known: ${PURPOSES.join(', ')}`);
    }
    let v;
    try { v = parseFloor(value); } catch (err) {
      throw new Error(`Floor for "${purpose}": ${err.message}`);
    }
    if (!(v >= 0 && v <= 1)) throw new Error(`Floor for "${purpose}" must be between 0 and 100%, got ${value}`);
    floors[purpose] = v;
  }
  policy.floors = floors;

  for (const [name, limit] of Object.entries(policy.limits)) {
    if (!PERIOD_MS[limit.period]) {
      throw new Error(`Limit "${name}" has unknown period "${limit.period}". Known: ${Object.keys(PERIOD_MS).join(', ')}`);
    }
  }
  if (!['tokens', 'requests'].includes(policy.unit)) {
    throw new Error(`Unknown unit "${policy.unit}". Use tokens or requests.`);
  }
  if (!['usage-command', 'claude-code', 'gateway'].includes(policy.source)) {
    throw new Error(`Unknown source "${policy.source}". Use usage-command, claude-code, or gateway.`);
  }
  if (!['cli', 'api'].includes(policy.cloudTransport)) {
    throw new Error(`Unknown cloudTransport "${policy.cloudTransport}". Use cli (subscription) or api (metered).`);
  }
  if (!['local', 'error'].includes(policy.onExhausted)) {
    throw new Error(`onExhausted must be "local" or "error", got "${policy.onExhausted}"`);
  }
  return policy;
}

// ---------------------------------------------------------------------------
// Allowance meter
// ---------------------------------------------------------------------------

/**
 * Tracks how much of each window's allotment is left. Reads real Claude usage
 * from Claude Code transcripts (all sessions on this machine), so a stock Claude
 * session you ran outside Blaude still moves the needle.
 */
export class AllowanceMeter {
  /**
   * @param {object} opts
   * @param {Function} [opts.reader]      transcript aggregator (fallback source)
   * @param {Function} [opts.usageReader] `/usage` reader (primary source)
   */
  constructor({ policy, ttlMs = 15_000, now = () => Date.now(), reader = claudeUsageReport, usageReader = readUsageCommand } = {}) {
    this.policy = policy;
    this.ttlMs = ttlMs;
    this.now = now;
    this.reader = reader;
    this.usageReader = usageReader;
    this.windows = {};   // name -> {spent, amount, remaining, fraction}
    this.fetchedAt = 0;
    this.gatewaySpend = []; // used when source === 'gateway'
  }

  get stale() { return this.now() - this.fetchedAt >= this.ttlMs; }

  async refresh(force = false) {
    if (!force && !this.stale) return this.windows;

    if (this.policy.source === 'usage-command') {
      try {
        this.windows = await this.#fromUsageCommand();
        this.effectiveSource = 'usage-command';
        this.lastError = null;
        this.fetchedAt = this.now();
        return this.windows;
      } catch (err) {
        // Fall through to the transcript estimate rather than failing closed.
        this.lastError = err.message;
      }
    }

    const windowSpans = Object.fromEntries(
      Object.entries(this.policy.limits).map(([name, l]) => [name, PERIOD_MS[l.period]]),
    );

    let spentByWindow;
    if (this.policy.source === 'gateway') {
      spentByWindow = Object.fromEntries(
        Object.entries(windowSpans).map(([name, span]) => {
          const from = this.now() - span;
          const total = this.gatewaySpend
            .filter((e) => e.ts >= from)
            .reduce((n, e) => n + (this.policy.unit === 'requests' ? 1 : e.tokens), 0);
          return [name, total];
        }),
      );
    } else {
      const report = await this.reader({ weights: this.policy.weights, windows: windowSpans, now: this.now() });
      spentByWindow = Object.fromEntries(
        Object.entries(report.windows).map(([name, w]) => [
          name,
          this.policy.unit === 'requests' ? w.totals.requests : w.weighted,
        ]),
      );
    }

    const out = {};
    for (const [name, limit] of Object.entries(this.policy.limits)) {
      const spent = spentByWindow[name] || 0;
      const amount = limit.amount || 0;
      out[name] = {
        period: limit.period,
        amount,
        spent,
        remaining: amount ? Math.max(0, amount - spent) : null,
        fractionRemaining: amount ? Math.max(0, 1 - spent / amount) : null,
      };
    }
    this.windows = out;
    this.effectiveSource = this.policy.source === 'gateway' ? 'gateway' : 'claude-code';
    this.fetchedAt = this.now();
    return out;
  }

  /** Exact state from `claude -p "/usage"` — percentages, not estimates. */
  async #fromUsageCommand() {
    const report = await this.usageReader();
    const periodFor = (name) => (name === 'session' ? '5h' : name.startsWith('weekly') ? 'week' : 'unknown');
    const out = {};
    for (const [name, w] of Object.entries(report.windows)) {
      out[name] = {
        period: periodFor(name),
        fractionRemaining: w.fractionRemaining,
        usedPercent: w.usedPercent,
        resetsAt: w.resetsAt,
        model: w.model ?? null,
        perModel: Boolean(w.model),
        amount: null,   // /usage reports percentages, not token ceilings
        spent: null,
        source: 'usage-command',
      };
    }
    this.subscription = report.subscription;
    this.requestCounts = { day: report.requests24h, week: report.requests7d };
    return out;
  }

  /** Cloud traffic Blaude itself forwarded, for source: "gateway". */
  record(entry) {
    if (!entry?.cloud) return;
    this.gatewaySpend.push({ ts: Date.now(), tokens: (entry.inputTokens || 0) + (entry.outputTokens || 0) });
    this.fetchedAt = 0; // force a recompute on next read
  }

  /**
   * The binding constraint across the account-wide windows. Per-model windows
   * (e.g. "Current week (Opus)") are excluded here — they only bind the model
   * they name, so use tightestFor(model) when a specific model is in play.
   */
  tightest() {
    let worst = null;
    for (const [name, w] of Object.entries(this.windows)) {
      if (w.fractionRemaining == null || w.perModel) continue;
      if (!worst || w.fractionRemaining < worst.fractionRemaining) worst = { name, ...w };
    }
    return worst;
  }

  /**
   * Binding constraint for a specific cloud model: the account-wide windows plus
   * that model's own weekly window if `/usage` reports one. Prevents Blaude from
   * routing an audit to Opus when the Opus week is spent but the account is not.
   */
  tightestFor(model) {
    let worst = this.tightest();
    if (!model) return worst;
    const needle = String(model).toLowerCase();
    for (const [name, w] of Object.entries(this.windows)) {
      if (!w.perModel || w.fractionRemaining == null) continue;
      const label = String(w.model || name).toLowerCase();
      if (!needle.includes(label) && !label.includes(needle)) continue;
      if (!worst || w.fractionRemaining < worst.fractionRemaining) worst = { name, ...w };
    }
    return worst;
  }

  /** True when nothing usable could be determined about the allowance. */
  get uncalibrated() {
    const values = Object.values(this.windows);
    return !values.length || values.every((w) => w.fractionRemaining == null);
  }
}

// ---------------------------------------------------------------------------
// Turn affinity — the mechanism behind a clean handoff
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';

/**
 * Remembers where the current turn is being served so a mid-turn tool loop never
 * changes destination. Keyed on the conversation's opening user message, which
 * is stable for the life of a session; a fresh user prompt re-decides because it
 * classifies as `main`.
 */
export class TurnAffinity {
  constructor({ ttlMs = 6 * 3600_000, max = 500, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.max = max;
    this.now = now;
    this.map = new Map(); // key -> {destination, model, at, turns}
  }

  static fingerprint(body) {
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    for (const m of messages) {
      if (m?.role !== 'user') continue;
      const text = typeof m.content === 'string'
        ? m.content
        : (m.content || []).filter((b) => b?.type === 'text').map((b) => b.text).join('');
      if (text) return createHash('sha1').update(text.slice(0, 512)).digest('hex').slice(0, 16);
    }
    return null;
  }

  get(key) {
    if (!key) return null;
    const entry = this.map.get(key);
    if (!entry) return null;
    if (this.now() - entry.at > this.ttlMs) { this.map.delete(key); return null; }
    return entry;
  }

  set(key, destination, model) {
    if (!key) return;
    if (this.map.size >= this.max) {
      // Drop the oldest; this is a routing hint, not durable state.
      const oldest = [...this.map.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) this.map.delete(oldest[0]);
    }
    const prev = this.map.get(key);
    this.map.set(key, { destination, model, at: this.now(), turns: (prev?.turns || 0) + 1 });
  }
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/**
 * @returns {{destination:'local'|'cloud', purpose:string, model:string|null,
 *            reason:string, floor:number, window?:object, capability?:string}}
 */
export function decide({
  policy, meter, body, requestedModel, explicit = null, localCapabilities = {}, affinity = null,
  // How a cloud destination would actually be served. The gateway must relay the
  // turn through `claude -p`; the launcher execs `claude` directly and relays
  // nothing, so the relay's cost has no bearing on its decision.
  transport = 'relay',
}) {
  const purpose = classifyRequest(body, { requestedModel });
  const floor = policy.floors?.[purpose] ?? NEVER;
  const candidateModel = policy.cloudModels?.[purpose];
  const tight = meter.tightestFor ? meter.tightestFor(candidateModel) : meter.tightest();
  const base = { purpose, floor, window: tight };
  const fingerprint = affinity ? TurnAffinity.fingerprint(body) : null;

  // Mid-turn: stay where the turn started. Flipping now would force Claude to
  // re-cache a long conversation (expensive) or hand the local model a
  // half-finished Claude turn (confusing). The switch happens on the next prompt.
  if (affinity && policy.handoff?.stickyTurns && purpose !== 'main' && explicit === null) {
    const held = affinity.get(fingerprint);
    const hardStop = tight && tight.fractionRemaining != null
      && tight.fractionRemaining <= (policy.handoff.hardStopFraction ?? 0);
    if (held && !(held.destination === 'cloud' && hardStop)) {
      return {
        ...base,
        destination: held.destination,
        model: held.model,
        sticky: true,
        reason: `continuing this turn on ${held.destination === 'cloud' ? 'Claude' : 'the local model'} ` +
          `(handoff waits for the next prompt)`,
      };
    }
    if (held && hardStop) {
      return {
        ...base,
        destination: 'local',
        model: policy.localModels?.[purpose] || null,
        handoff: 'hard-stop',
        reason: `only ${pct(tight.fractionRemaining)} of ${tight.name} allowance left — ` +
          `breaking turn affinity to protect the remainder`,
      };
    }
  }

  if (explicit === 'cloud') {
    return { ...base, destination: 'cloud', model: stripPurposePrefix(requestedModel), reason: 'explicit cloud/ prefix — bypasses the budget' };
  }
  if (explicit === 'local') {
    return { ...base, destination: 'local', model: stripPurposePrefix(requestedModel), reason: 'explicit local/ prefix' };
  }

  const wantsTools = Array.isArray(body?.tools) && body.tools.length > 0;
  const localFallback = { ...base, destination: 'local', model: policy.localModels?.[purpose] || null };

  // Capability routing: the local model physically cannot do what was asked.
  // local-only means local-only, so it opts out entirely.
  if (wantsTools && policy.capabilityRouting?.toolsRequireClaude
      && localCapabilities.tools === false && policy.mode !== 'local-only') {
    const capFloor = policy.capabilityRouting.floor ?? 0.05;
    if (floorBlocks(capFloor, tight)) {
      return {
        ...localFallback,
        capability: 'tools-unsupported',
        reason: `local backend has no tool support, and only ${pct(tight?.fractionRemaining)} of the ` +
          `${tight?.name} allowance is left (capability floor ${pct(capFloor)}) — serving locally with ` +
          `text tool-call parsing`,
      };
    }
    return {
      ...base,
      destination: 'cloud',
      model: policy.cloudModels?.[purpose] || 'sonnet',
      capability: 'tools-unsupported',
      reason: `local backend cannot do tool calls — routing this one to Claude ` +
        `(capability floor ${pct(capFloor)}, ${pct(tight?.fractionRemaining)} left)`,
    };
  }

  if (floor >= NEVER) {
    return { ...localFallback, reason: `mode "${policy.mode}" keeps ${purpose} local` };
  }
  if (meter.uncalibrated) {
    return {
      ...localFallback,
      reason: 'no allowance figures available — staying local. Check `blaude doctor`, ' +
        'or run `blaude calibrate --write` to set ceilings for the fallback estimator.',
    };
  }

  const blocked = floorBlocks(floor, tight);
  if (blocked && affinity && purpose === 'main') {
    const previous = affinity.get(fingerprint);
    if (previous?.destination === 'cloud') localFallback.handoff = 'claude->local';
    affinity.set(fingerprint, 'local', localFallback.model);
  }
  if (blocked) {
    if (policy.onExhausted === 'error') {
      const err = new Error(
        `Claude is off-limits for "${purpose}": ${pct(tight.fractionRemaining)} of the ${tight.name} ` +
        `allowance remains, below its ${pct(floor)} floor.`,
      );
      err.status = 429;
      err.type = 'rate_limit_error';
      throw err;
    }
    return {
      ...localFallback,
      exhausted: true,
      reason: `${pct(tight.fractionRemaining)} of ${tight.name} allowance left, under the ${pct(floor)} floor for ${purpose} — staying local`,
    };
  }

  // The relay is measurably worse than a native session for ordinary turns, so
  // it is never used for them. This applies only to callers that would actually
  // relay: a native launch pays none of the cost, and declining it there was
  // self-defeating — the decline message recommends `blaude route auto`, which
  // is the very path it was refusing.
  const isOrdinaryTurn = purpose === 'main' || purpose === 'tools';
  if (isOrdinaryTurn && transport === 'relay' && policy.cloudTransport === 'cli') {
    return {
      ...localFallback,
      relayDeclined: true,
      reason:
        `${pct(tight.fractionRemaining)} of ${tight.name} allowance left, but Blaude is in the request ` +
        `path, and relaying an ordinary turn through the CLI costs ~2x the tokens and ~4x the wall clock ` +
        `of a native session — staying local. Run \`blaude route auto\` for Claude to do the work itself.`,
    };
  }

  const chosen = {
    ...base,
    destination: 'cloud',
    model: policy.cloudModels?.[purpose] || 'sonnet',
    reason: `${pct(tight.fractionRemaining)} of ${tight.name} allowance left (floor ${pct(floor)}) — Claude it is`,
  };
  if (affinity && purpose === 'main') affinity.set(fingerprint, 'cloud', chosen.model);
  return chosen;
}

function floorBlocks(floor, tight) {
  if (floor >= NEVER) return true;
  if (!tight) return false; // nothing calibrated: do not block on an unknown
  return tight.fractionRemaining <= floor;
}

export function pct(fraction) {
  if (fraction == null) return '—';
  return `${Math.round(fraction * 1000) / 10}%`;
}

export function fmt(n) {
  if (n == null) return '—';
  if (n === Infinity) return '∞';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n * 100) / 100);
}

/** Where each purpose goes right now, for `blaude status`. */
export function explainPolicy(policy, meter, localCapabilities = {}) {
  return PURPOSES.map((purpose) => {
    const tight = meter.tightestFor
      ? meter.tightestFor(policy.cloudModels?.[purpose])
      : meter.tightest();
    const floor = policy.floors?.[purpose] ?? NEVER;
    const blocked = floorBlocks(floor, tight) || meter.uncalibrated;
    return {
      purpose,
      floor,
      destination: blocked ? 'local' : 'cloud',
      model: blocked
        ? (policy.localModels[purpose] || '(default local)')
        : (policy.cloudModels[purpose] || 'sonnet'),
      remaining: tight?.fractionRemaining ?? null,
      binding: tight?.name ?? null,
    };
  });
}
