import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePolicy, classifyRequest, decide, TurnAffinity, AllowanceMeter,
  MODES, NEVER, explainPolicy,
} from '../src/policy.mjs';

/** A meter with a fixed remaining fraction, so decisions are deterministic. */
function fakeMeter(remaining, { name = 'weekly', perModel = {} } = {}) {
  const base = { name, fractionRemaining: remaining, spent: 0, amount: 100, period: 'week' };
  return {
    windows: { [name]: base },
    uncalibrated: remaining == null,
    tightest: () => (remaining == null ? null : base),
    tightestFor: (model) => {
      if (remaining == null) return null;
      const override = perModel[model];
      if (override != null && override < remaining) return { name: `weekly-${model}`, fractionRemaining: override, spent: 0, amount: 100 };
      return base;
    },
    refresh: async () => {},
    record: () => {},
  };
}

const freshTurn = { messages: [{ role: 'user', content: 'do the thing' }] };
const loopTurn = {
  messages: [
    { role: 'user', content: 'do the thing' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] },
  ],
};

test('purpose classification distinguishes the four request kinds', () => {
  assert.equal(classifyRequest(freshTurn, { requestedModel: 'claude-sonnet-5' }), 'main');
  assert.equal(classifyRequest(loopTurn, { requestedModel: 'claude-sonnet-5' }), 'tools');
  assert.equal(classifyRequest({ messages: [{ role: 'user', content: 'x' }] }, { requestedModel: 'audit/opus' }), 'audit');
  assert.equal(classifyRequest({ messages: [{ role: 'user', content: 'x' }] }, { requestedModel: 'claude-haiku-4-5' }), 'background');
  assert.equal(classifyRequest({ metadata: { blaude_purpose: 'audit' }, messages: [{ role: 'user', content: 'x' }] }, {}), 'audit');
});

test('percentages are accepted as 20, 0.2 or "20%"', () => {
  for (const value of [20, 0.2, '20%']) {
    const p = normalizePolicy({ mode: 'claude-first', floors: { main: value } });
    assert.equal(p.floors.main, 0.2, `failed for ${JSON.stringify(value)}`);
  }
});

test('invalid policies are rejected with a useful message', () => {
  assert.throws(() => normalizePolicy({ mode: 'nope' }), /Unknown Blaude mode/);
  assert.throws(() => normalizePolicy({ floors: { nonsense: 0.5 } }), /unknown purpose/);
  assert.throws(() => normalizePolicy({ cloudTransport: 'telepathy' }), /cloudTransport/);
  assert.throws(() => normalizePolicy({ source: 'vibes' }), /Unknown source/);
});

test('claude-audits keeps work local and lets audits reach Claude', () => {
  const policy = normalizePolicy({ mode: 'claude-audits' });
  const meter = fakeMeter(0.8);
  assert.equal(decide({ policy, meter, body: freshTurn, requestedModel: 'claude-sonnet-5' }).destination, 'local');
  assert.equal(decide({ policy, meter, body: freshTurn, requestedModel: 'audit/opus' }).destination, 'cloud');
});

test('claude-first falls back exactly at the floor', () => {
  const policy = normalizePolicy({ mode: 'claude-first', floors: { main: 20 } });
  assert.equal(decide({ policy, meter: fakeMeter(0.21), body: freshTurn, requestedModel: 'm' , transport: 'native' }).destination, 'cloud');
  assert.equal(decide({ policy, meter: fakeMeter(0.20), body: freshTurn, requestedModel: 'm' , transport: 'native' }).destination, 'local');
  assert.equal(decide({ policy, meter: fakeMeter(0.19), body: freshTurn, requestedModel: 'm' , transport: 'native' }).destination, 'local');
});

test('reserved tails let audits continue after ordinary work has fallen back', () => {
  const policy = normalizePolicy({ mode: 'claude-first', floors: { main: 20, tools: 10, audit: 5 } });
  const meter = fakeMeter(0.08); // 8% left
  assert.equal(decide({ policy, meter, body: freshTurn, requestedModel: 'm' , transport: 'native' }).destination, 'local');
  assert.equal(decide({ policy, meter, body: loopTurn, requestedModel: 'm' , transport: 'native' }).destination, 'local');
  assert.equal(decide({ policy, meter, body: freshTurn, requestedModel: 'audit/opus' , transport: 'native' }).destination, 'cloud',
    'the audit reserve must still be available');
});

test('a per-model window blocks only that model', () => {
  const policy = normalizePolicy({ mode: 'claude-first', floors: { main: 10, audit: 5 } });
  // Account-wide is healthy, but the Opus week is spent.
  const meter = fakeMeter(0.9, { perModel: { opus: 0.01 } });
  assert.equal(decide({ policy, meter, body: freshTurn, requestedModel: 'm' , transport: 'native' }).destination, 'cloud');
  assert.equal(decide({ policy, meter, body: freshTurn, requestedModel: 'audit/x' , transport: 'native' }).destination, 'local',
    'an exhausted Opus week must stop an Opus audit');
});

test('explicit prefixes override the policy in both directions', () => {
  const policy = normalizePolicy({ mode: 'local-only' });
  const meter = fakeMeter(0.5);
  assert.equal(decide({ policy, meter, body: freshTurn, requestedModel: 'cloud/opus', explicit: 'cloud' }).destination, 'cloud');
  const strict = normalizePolicy({ mode: 'claude-first', floors: { main: 0 } });
  assert.equal(decide({ policy: strict, meter, body: freshTurn, requestedModel: 'local/blaude', explicit: 'local' }).destination, 'local');
});

test('onExhausted:error raises a 429 instead of falling back', () => {
  const policy = normalizePolicy({ mode: 'claude-first', floors: { main: 50 }, onExhausted: 'error' });
  assert.throws(
    () => decide({ policy, meter: fakeMeter(0.1), body: freshTurn, requestedModel: 'm' }),
    (err) => err.status === 429 && err.type === 'rate_limit_error',
  );
});

test('an uncalibrated meter never spends Claude by accident', () => {
  const policy = normalizePolicy({ mode: 'claude-first', floors: { main: 0 } });
  const d = decide({ policy, meter: fakeMeter(null), body: freshTurn, requestedModel: 'm' });
  assert.equal(d.destination, 'local');
  assert.match(d.reason, /no allowance figures/i);
});

test('a turn finishes where it started, and hands off on the next prompt', () => {
  const policy = normalizePolicy({ mode: 'claude-first', floors: { main: 20, tools: 20 } });
  const affinity = new TurnAffinity();

  // Turn starts with plenty of allowance.
  let meter = fakeMeter(0.5);
  assert.equal(decide({ policy, meter, body: freshTurn, requestedModel: 'm', affinity , transport: 'native' }).destination, 'cloud');

  // Allowance collapses mid-turn: the loop must stay on Claude.
  meter = fakeMeter(0.15);
  const mid = decide({ policy, meter, body: loopTurn, requestedModel: 'm', affinity , transport: 'native' });
  assert.equal(mid.destination, 'cloud');
  assert.ok(mid.sticky);

  // The next user prompt is where the handoff lands.
  const nextTurn = { messages: [...freshTurn.messages, { role: 'assistant', content: 'done' }, { role: 'user', content: 'next' }] };
  const after = decide({ policy, meter, body: nextTurn, requestedModel: 'm', affinity , transport: 'native' });
  assert.equal(after.destination, 'local');
  assert.equal(after.handoff, 'claude->local');
});

test('the hard stop breaks turn affinity to protect the remainder', () => {
  const policy = normalizePolicy({ mode: 'claude-first', floors: { main: 20, tools: 20 } });
  const affinity = new TurnAffinity();
  affinity.set(TurnAffinity.fingerprint(loopTurn), 'cloud', 'sonnet');
  const d = decide({ policy, meter: fakeMeter(0.01), body: loopTurn, requestedModel: 'm', affinity , transport: 'native' });
  assert.equal(d.destination, 'local');
  assert.equal(d.handoff, 'hard-stop');
});

test('capability routing reaches Claude even when the purpose floor says never', () => {
  // local-first keeps `main` local, but a request the local model cannot serve
  // at all is a different question: it escalates on its own bounded floor.
  const policy = normalizePolicy({ mode: 'claude-audits', capabilityRouting: { toolsRequireClaude: true } });
  const body = { ...freshTurn, tools: [{ name: 'Read', input_schema: {} }] };
  const d = decide({ policy, meter: fakeMeter(0.5), body, requestedModel: 'm', localCapabilities: { tools: false } });
  assert.equal(d.destination, 'cloud');
  assert.equal(d.capability, 'tools-unsupported');
});

test('capability escalation is bounded by its own floor and off in local-only', () => {
  const policy = normalizePolicy({ mode: 'claude-audits', capabilityRouting: { toolsRequireClaude: true, floor: 0.05 } });
  const body = { ...freshTurn, tools: [{ name: 'Read', input_schema: {} }] };
  const broke = decide({ policy, meter: fakeMeter(0.02), body, requestedModel: 'm', localCapabilities: { tools: false } });
  assert.equal(broke.destination, 'local', 'must not drain the last of the allowance');

  const localOnly = normalizePolicy({ mode: 'local-only', capabilityRouting: { toolsRequireClaude: true } });
  const d = decide({ policy: localOnly, meter: fakeMeter(0.9), body, requestedModel: 'm', localCapabilities: { tools: false } });
  assert.equal(d.destination, 'local', 'local-only must mean local-only');
});

test('every mode preset is coherent', () => {
  for (const [name, mode] of Object.entries(MODES)) {
    const policy = normalizePolicy({ mode: name });
    assert.ok(mode.description.length > 10, `${name} needs a description`);
    const rows = explainPolicy(policy, fakeMeter(0.5));
    assert.equal(rows.length, 4);
    if (name === 'local-only') {
      assert.ok(rows.every((r) => r.destination === 'local'), 'local-only must never route to Claude');
    }
  }
});

test('no two modes are the same mode wearing a different description', () => {
  // `split` promised "Claude for thinking, local for the grind" and delivered
  // claude-first: in the request path ordinary turns never reach Claude, and out
  // of it the session is native so Claude does the grind too. A preset that
  // cannot be told apart from another is a description, not a behaviour.
  const behaviour = (name) => {
    const policy = normalizePolicy({ mode: name });
    return [0.9, 0.5, 0.25, 0.03].flatMap((left) => [
      decide({ policy, meter: fakeMeter(left), body: freshTurn, requestedModel: 'm' }).destination,
      decide({ policy, meter: fakeMeter(left), body: loopTurn, requestedModel: 'm' }).destination,
      decide({ policy, meter: fakeMeter(left), body: freshTurn, requestedModel: 'audit/opus' }).destination,
      decide({ policy, meter: fakeMeter(left), body: freshTurn, requestedModel: 'm', transport: 'native' }).destination,
    ]).join(',');
  };

  const seen = new Map();
  for (const name of Object.keys(MODES)) {
    const sig = behaviour(name);
    assert.ok(!seen.has(sig), `mode "${name}" behaves identically to "${seen.get(sig)}"`);
    seen.set(sig, name);
  }
});

test('a retired mode name still resolves rather than throwing', () => {
  assert.equal(normalizePolicy({ mode: 'split' }).mode, 'claude-first');
  assert.equal(normalizePolicy({ mode: 'local-first' }).mode, 'claude-audits');
});

test('the meter falls back to estimates when /usage cannot be read', async () => {
  const policy = normalizePolicy({ source: 'usage-command', limits: { weekly: { period: 'week', amount: 1000 } } });
  const meter = new AllowanceMeter({
    policy,
    usageReader: async () => { throw new Error('claude CLI unavailable in this test'); },
    reader: async () => ({ windows: { weekly: { totals: { requests: 1 }, weighted: 250 } } }),
  });
  await meter.refresh(true);
  assert.ok(meter.lastError, 'the /usage failure should be recorded');
  assert.equal(meter.effectiveSource, 'claude-code');
  assert.equal(meter.windows.weekly.fractionRemaining, 0.75);
});

// --- CLI safety -------------------------------------------------------------
// A mistyped command must never be silently sent as a prompt: above the floor
// that would spend a Claude turn on a typo.
const cliModule = await import('../src/cli.mjs');
const { nearestCommand } = cliModule;
const require_cli = () => cliModule;

test('a mistyped command is recognised as a near-miss', () => {
  assert.equal(nearestCommand('model'), 'mode');
  assert.equal(nearestCommand('stat'), 'stats');
  assert.equal(nearestCommand('doctr'), 'doctor');
  assert.equal(nearestCommand('usag'), 'usage');
});

test('a genuine prompt is not mistaken for a command', () => {
  for (const prompt of ['fix', 'implement', 'why-does-this-break', 'refactor']) {
    if (prompt === 'why-does-this-break') {
      assert.equal(nearestCommand(prompt), null, prompt);
      continue;
    }
    const near = nearestCommand(prompt);
    assert.ok(near === null || near === prompt, `"${prompt}" should not be corrected, got ${near}`);
  }
  assert.equal(nearestCommand('"quoted text"'), null);
  assert.equal(nearestCommand(''), null);
});

test('the old mode name still resolves, so existing configs keep working', () => {
  const legacy = normalizePolicy({ mode: 'local-first' });
  assert.equal(legacy.mode, 'claude-audits');
  assert.deepEqual(legacy.floors, normalizePolicy({ mode: 'claude-audits' }).floors);
});

test('an ordinary turn is not relayed through the CLI by default', () => {
  // Measured: ~2x the tokens, ~4x the latency, and it did not finish the task.
  const policy = normalizePolicy({ mode: 'claude-first', floors: { main: 0, tools: 0 } });
  const d = decide({ policy, meter: fakeMeter(0.9), body: freshTurn, requestedModel: 'm' });
  assert.equal(d.destination, 'local');
  assert.ok(d.relayDeclined);
  assert.match(d.reason, /route auto/);
});

test('audits still escalate over the same transport', () => {
  const policy = normalizePolicy({ mode: 'claude-first' });
  const d = decide({ policy, meter: fakeMeter(0.9), body: freshTurn, requestedModel: 'audit/opus' });
  assert.equal(d.destination, 'cloud', 'a coarse one-shot audit is not affected');
});

test('an ordinary turn is never relayed, at any allowance', () => {
  // There is no flag to turn this back on: the relay measured at ~2x the tokens
  // and ~4x the wall clock of a native session, and did not finish reliably.
  const policy = normalizePolicy({ mode: 'claude-first', floors: { main: 0 } });
  for (const remaining of [0.9, 0.5, 0.99]) {
    const d = decide({ policy, meter: fakeMeter(remaining), body: freshTurn, requestedModel: 'm' });
    assert.equal(d.destination, 'local', `${remaining} remaining still must not relay`);
    assert.ok(d.relayDeclined);
  }
});

test('the same turn goes to Claude when the launcher will run it natively', () => {
  // Same policy, same allowance, different caller: `blaude route auto` execs
  // `claude` directly, so the relay's cost never applies and declining it there
  // was self-defeating.
  const policy = normalizePolicy({ mode: 'claude-first', floors: { main: 20 } });
  const d = decide({ policy, meter: fakeMeter(0.26), body: freshTurn, requestedModel: 'm', transport: 'native' });
  assert.equal(d.destination, 'cloud');
  assert.equal(d.model, 'sonnet');

  // The floor still binds — native is not a bypass.
  const low = decide({ policy, meter: fakeMeter(0.05), body: freshTurn, requestedModel: 'm', transport: 'native' });
  assert.equal(low.destination, 'local');
  assert.ok(low.exhausted);
});

test('the launcher forwards every flag it does not own', () => {
  const { splitLauncherArgs } = require_cli();
  const { ours, passthrough } = splitLauncherArgs(
    ['--local', '-p', '--output-format', 'json', '--allowedTools', 'Read,Glob', 'count the TODOs'],
  );
  assert.equal(ours.local, true);
  assert.deepEqual(passthrough, ['-p', '--output-format', 'json', '--allowedTools', 'Read,Glob', 'count the TODOs'],
    'anything Blaude does not own must reach claude untouched');
});

test('-- forces everything after it to pass through', () => {
  const { splitLauncherArgs } = require_cli();
  const { ours, passthrough } = splitLauncherArgs(['--', '--local', 'is a prompt word']);
  assert.deepEqual(ours, {});
  assert.deepEqual(passthrough, ['--local', 'is a prompt word']);
});

test('--local pins the gateway, not just the banner', () => {
  const { localSessionEnv } = require_cli();
  const cfg = { host: '127.0.0.1', port: 8817, defaultModel: 'blaude', models: { blaude: { maxContext: 40960 } } };
  assert.equal(localSessionEnv(cfg).ANTHROPIC_MODEL, 'blaude', 'without --local the gateway decides');
  assert.equal(localSessionEnv(cfg, { force: true }).ANTHROPIC_MODEL, 'local/blaude',
    'with --local the model carries the prefix that forbids escalation');
  assert.equal(localSessionEnv(cfg, { force: true }).ANTHROPIC_SMALL_FAST_MODEL, 'local/blaude-small');
});

test('a small local window suppresses compaction rather than declaring itself', () => {
  const { localSessionEnv, localSessionArgs, needsCompactionGuard } = require_cli();
  const small = { host: '127.0.0.1', port: 8817, defaultModel: 'blaude', models: { blaude: { maxContext: 40960 } }, localSession: {} };
  const roomy = { host: '127.0.0.1', port: 8817, defaultModel: 'blaude', models: { blaude: { maxContext: 131072 } }, localSession: {} };

  // Declaring 40k leaves ~12k of working room over Claude Code's base prompt,
  // which sends auto-compact into a loop.
  assert.equal(localSessionEnv(small).CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined);
  assert.ok(needsCompactionGuard(small));
  assert.ok(localSessionArgs(small).includes('--autocompact'));

  assert.equal(localSessionEnv(roomy).CLAUDE_CODE_MAX_CONTEXT_TOKENS, '131072');
  assert.ok(!needsCompactionGuard(roomy));
  assert.ok(!localSessionArgs(roomy).includes('--autocompact'));
});
