import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// account.mjs resolves BLAUDE_HOME at import time, so the sandbox has to exist
// before the module is loaded.
const HOME = mkdtempSync(join(tmpdir(), 'blaude-account-'));
process.env.BLAUDE_HOME = HOME;
const { accountKey, portForAccount, cachedAccount } = await import('../src/account.mjs');

const work = { email: 'a@example.com', orgId: 'org-team' };
const personal = { email: 'a@gmail.com', orgId: 'org-personal' };

test('an account key is stable, and distinguishes org as well as email', () => {
  assert.equal(accountKey(work), accountKey({ ...work }));
  assert.notEqual(accountKey(work), accountKey(personal));
  // Same person, two orgs, two allowances.
  assert.notEqual(accountKey(work), accountKey({ email: work.email, orgId: 'org-other' }));
  assert.equal(accountKey({}), 'unknown');
});

test('two accounts never land on the same gateway port', () => {
  const a = { ...work, key: accountKey(work) };
  const b = { ...personal, key: accountKey(personal) };
  assert.notEqual(portForAccount(8817, a), portForAccount(8817, b));
  // Deterministic, so the same account reconnects to its own gateway.
  assert.equal(portForAccount(8817, a), portForAccount(8817, a));
  // And in range, so the offset cannot wander into someone else's service.
  for (const acct of [a, b]) {
    const port = portForAccount(8817, acct);
    assert.ok(port >= 8817 && port < 8817 + 200, `${port} out of range`);
  }
});

test('an unidentified account falls back to the base port', () => {
  assert.equal(portForAccount(8817, null), 8817);
  assert.equal(portForAccount(8817, {}), 8817);
});

test('the cached account is read per config dir, without spawning', () => {
  writeFileSync(join(HOME, 'accounts.json'), JSON.stringify({
    '(default)': { at: 0, account: { ...work, key: accountKey(work) } },
    '/Users/x/.claude-personal': { at: 0, account: { ...personal, key: accountKey(personal) } },
  }));

  assert.equal(cachedAccount({ env: {} }).email, work.email);
  assert.equal(cachedAccount({ env: { CLAUDE_CONFIG_DIR: '/Users/x/.claude-personal' } }).email, personal.email);
  // An entry that is old is still the right identity — staleness is the usage
  // reading's problem, not the account's.
  assert.ok(cachedAccount({ env: {} }));
  assert.equal(cachedAccount({ env: { CLAUDE_CONFIG_DIR: '/nope' } }), null);
});

const { assertGatewayAccount } = await import('../src/cli.mjs');

const cfg = { host: '127.0.0.1', port: 8979 };
const mine = { email: 'a@gmail.com', key: accountKey(personal) };
const theirs = { ok: true, account: { email: 'a@example.com', key: accountKey(work) } };

test('a gateway signed in as another account is refused, not adopted', () => {
  assert.throws(() => assertGatewayAccount(theirs, cfg, mine), /signed in as a@example\.com/);
});

test('our own gateway, or one we cannot identify, is left alone', () => {
  assert.doesNotThrow(() => assertGatewayAccount({ ok: true, account: mine }, cfg, mine));
  // An older gateway predates /health reporting an account; refusing every one
  // of those would strand the user with no way forward.
  assert.doesNotThrow(() => assertGatewayAccount({ ok: true }, cfg, mine));
  assert.doesNotThrow(() => assertGatewayAccount(theirs, cfg, null));
});
