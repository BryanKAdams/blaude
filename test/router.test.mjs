import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveModel, globMatch, RouteError } from '../src/router.mjs';
import { DEFAULTS } from '../src/config.mjs';

const cfg = JSON.parse(JSON.stringify(DEFAULTS));

test('globs match the way the config implies', () => {
  assert.ok(globMatch('*haiku*', 'claude-haiku-4-5-20251001'));
  assert.ok(globMatch('*', 'anything'));
  assert.ok(globMatch('local/*', 'local/blaude'));
  assert.ok(!globMatch('*haiku*', 'claude-sonnet-5'));
  assert.ok(globMatch('claude-opus-5[1m]', 'claude-opus-5[1m]'), 'literal brackets must not act as a character class');
});

test('unknown Claude model ids fall through to the local default', () => {
  for (const id of ['claude-sonnet-5', 'claude-opus-5[1m]', 'some-future-model']) {
    const r = resolveModel(cfg, id);
    assert.equal(r.backendName, 'ollama');
    assert.equal(r.passthrough, false);
  }
});

test('haiku-class ids route to the small local model', () => {
  assert.equal(resolveModel(cfg, 'claude-haiku-4-5-20251001').model, cfg.models['blaude-small'].model);
});

test('local/ and blaude/ prefixes select a configured local model', () => {
  assert.equal(resolveModel(cfg, 'local/blaude-small').target, 'blaude-small');
  assert.equal(resolveModel(cfg, 'blaude/blaude').target, 'blaude');
  assert.throws(() => resolveModel(cfg, 'local/nope'), /Unknown local model/);
});

test('cloud/ requires a key and says how to proceed without one', () => {
  const noKey = { ...cfg, backends: { ...cfg.backends, anthropic: { ...cfg.backends.anthropic, apiKey: null, apiKeyEnv: 'BLAUDE_TEST_MISSING_KEY' } } };
  try {
    resolveModel(noKey, 'cloud/claude-opus-4-5');
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof RouteError);
    assert.equal(err.status, 401);
    assert.match(err.message, /subscription/, 'should point at the subscription path');
  }
});

test('cloud/ passes through when a key is configured', () => {
  const withKey = { ...cfg, backends: { ...cfg.backends, anthropic: { ...cfg.backends.anthropic, apiKey: 'sk-test' } } };
  const r = resolveModel(withKey, 'cloud/claude-opus-4-5');
  assert.equal(r.passthrough, true);
  assert.equal(r.model, 'claude-opus-4-5');
});

test('a missing model is a clear error', () => {
  assert.throws(() => resolveModel(cfg, ''), /missing the "model"/);
});
