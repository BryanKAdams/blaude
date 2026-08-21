import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUsageOutput } from '../src/usage-command.mjs';
import { groupLimitIncidents, weighTokens, isClaudeModel, DEFAULT_WEIGHTS } from '../src/claude-usage.mjs';

// Verbatim shape of real `claude -p "/usage"` output.
const REAL = `You are currently using your subscription to power your Claude Code usage

Current session: 0% used
Current week (all models): 100% used · resets Aug 24 at 1pm (America/Denver)

What's contributing to your limits usage?
Last 24h · 1002 requests · 9 sessions
  85% of your usage was at >150k context
Last 7d · 7927 requests · 40 sessions`;

test('parses the real /usage report', () => {
  const r = parseUsageOutput(REAL);
  assert.ok(r.ok);
  assert.ok(r.subscription);
  assert.equal(r.windows.session.usedPercent, 0);
  assert.equal(r.windows.session.fractionRemaining, 1);
  assert.equal(r.windows.weekly.usedPercent, 100);
  assert.equal(r.windows.weekly.fractionRemaining, 0);
  assert.match(r.windows.weekly.resetsAt, /Aug 24/);
  assert.equal(r.requests24h, 1002);
  assert.equal(r.requests7d, 7927);
});

test('picks up per-model weekly windows', () => {
  const r = parseUsageOutput('Current session: 10% used\nCurrent week (all models): 40% used\nCurrent week (Opus): 88% used · resets Friday');
  assert.equal(r.windows.weekly.usedPercent, 40);
  assert.equal(r.windows['weekly-opus'].usedPercent, 88);
  assert.equal(r.windows['weekly-opus'].model, 'Opus');
  assert.equal(r.windows['weekly-opus'].fractionRemaining, 0.12);
});

test('fractional percentages and odd spacing still parse', () => {
  const r = parseUsageOutput('Current session:  12.5 % used\nCurrent week (all models):99% used');
  assert.equal(r.windows.session.usedPercent, 12.5);
  assert.equal(r.windows.weekly.usedPercent, 99);
});

test('unrecognised output is reported as not-ok rather than guessed at', () => {
  assert.equal(parseUsageOutput('the format changed entirely').ok, false);
  assert.equal(parseUsageOutput('').ok, false);
});

test('only real Claude models count toward Claude spend', () => {
  assert.ok(isClaudeModel('claude-opus-5'));
  assert.ok(isClaudeModel('claude-sonnet-4-5'));
  assert.ok(!isClaudeModel('<synthetic>'), 'client-side placeholders must not count');
  assert.ok(!isClaudeModel('blaude'), 'locally served responses must not count');
  assert.ok(!isClaudeModel('qwen3:8b'));
});

test('bursts of 429 retries collapse into one incident', () => {
  const base = Date.parse('2026-08-06T17:39:00Z');
  const hits = [0, 6_000, 120_000, 5 * 3600_000].map((offset) => ({ ts: base + offset, kind: 'session' }));
  const incidents = groupLimitIncidents(hits);
  assert.equal(incidents.length, 2, 'three retries within 30 min are one incident; the later one is separate');
  assert.equal(incidents[0].count, 3);
});

test('token weighting discounts cache reads', () => {
  const usage = { input: 100, output: 100, cacheCreation: 100, cacheRead: 1000 };
  assert.equal(weighTokens(usage, DEFAULT_WEIGHTS), 100 + 100 + 100 + 100);
  assert.equal(weighTokens(usage, { input: 1, output: 1, cacheCreation: 1, cacheRead: 1 }), 1300);
});
