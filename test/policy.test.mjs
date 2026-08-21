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
  assert.equal(decide({ policy, meter: fakeMeter(0.21), body: freshTurn, requestedModel: 'm' }).destination, 'cloud');
  assert.equal(decide({ policy, meter: fakeMeter(0.20), body: freshTurn, requestedModel: 'm' }).destination, 'local');
  assert.equal(decide({ policy, meter: fakeMeter(0.19), body: freshTurn, requestedModel: 'm' }).destination, 'local');
});

test('reserved tails let audits continue after ordinary work has fallen back', () => {
  const policy = normalizePolicy({ mode: 'claude-first', floors: { main: 20, tools: 10, audit: 5 } });
  const meter = fakeMeter(0.08); // 8% left
  assert.equal(decide({ policy, meter, body: freshTurn, requestedModel: 'm' }).destination, 'local');
  assert.equal(decide({ policy, meter, body: loopTurn, requestedModel: 'm' }).destination, 'local');
  assert.equal(decide({ policy, meter, body: freshTurn, requestedModel: 'audit/opus' }).destination, 'cloud',
    'the audit reserve must still be available');
});

test('a per-model window blocks only that model', () => {
  const policy = normalizePolicy({ mode: 'claude-first', floors: { main: 10, audit: 5 } });
  // Account-wide is healthy, but the Opus week is spent.
  const meter = fakeMeter(0.9, { perModel: { opus: 0.01 } });
  assert.equal(decide({ policy, meter, body: freshTurn, requestedModel: 'm' }).destination, 'cloud');
  assert.equal(decide({ policy, meter, body: freshTurn, requestedModel: 'audit/x' }).destination, 'local',
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
  assert.equal(decide({ policy, meter, body: freshTurn, requestedModel: 'm', affinity }).destination, 'cloud');

  // Allowance collapses mid-turn: the loop must stay on Claude.
  meter = fakeMeter(0.15);
  const mid = decide({ policy, meter, body: loopTurn, requestedModel: 'm', affinity });
  assert.equal(mid.destination, 'cloud');
  assert.ok(mid.sticky);

  // The next user prompt is where the handoff lands.
  const nextTurn = { messages: [...freshTurn.messages, { role: 'assistant', content: 'done' }, { role: 'user', content: 'next' }] };
  const after = decide({ policy, meter, body: nextTurn, requestedModel: 'm', affinity });
  assert.equal(after.destination, 'local');
  assert.equal(after.handoff, 'claude->local');
});

test('the hard stop breaks turn affinity to protect the remainder', () => {
  const policy = normalizePolicy({ mode: 'claude-first', floors: { main: 20, tools: 20 } });
  const affinity = new TurnAffinity();
  affinity.set(TurnAffinity.fingerprint(loopTurn), 'cloud', 'sonnet');
  const d = decide({ policy, meter: fakeMeter(0.01), body: loopTurn, requestedModel: 'm', affinity });
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
const { nearestCommand } = await import('../src/cli.mjs');

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
