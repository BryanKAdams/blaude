// Which Claude account is this environment authenticated as?
//
// This matters more than it sounds. Blaude's whole policy rests on remaining
// allowance, and allowance belongs to an ACCOUNT — but the gateway is one
// long-lived process that reads `/usage` under whatever account it was started
// with. Point a second account's session at that gateway and it gets routing
// decisions computed from someone else's allowance.
//
// So: identify the account, key the usage cache by it, and give each account its
// own gateway.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { BLAUDE_HOME } from './config.mjs';

const CACHE_TTL_MS = 10 * 60_000;
const cacheFile = () => join(BLAUDE_HOME, 'accounts.json');

/** Stable short key for an account, safe for filenames and ports. */
export function accountKey(account) {
  if (!account?.email) return 'unknown';
  return createHash('sha1').update(`${account.email}|${account.orgId || ''}`).digest('hex').slice(0, 8);
}

function runAuthStatus({ bin = process.env.BLAUDE_CLAUDE_BIN || 'claude', env = process.env, timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['auth', 'status'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('claude auth status timed out')); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const start = out.indexOf('{');
        resolve(JSON.parse(out.slice(start, out.lastIndexOf('}') + 1)));
      } catch {
        reject(new Error(`could not parse auth status: ${out.slice(0, 200)}`));
      }
    });
  });
}

/**
 * The account for this environment as already known on disk, without spawning
 * anything.
 *
 * `readAccount` shells out to `claude auth status` on a miss, which is fine for
 * a command but not for the guard hook: that runs before every prompt, and a
 * cold read would stall each one by up to 15s. Identity per config dir barely
 * changes, so age is not checked here — the TTL exists to re-check whether the
 * login is still good, and the async path owns that.
 */
export function cachedAccount({ env = process.env } = {}) {
  const configDir = env.CLAUDE_CONFIG_DIR || '(default)';
  try {
    const cache = JSON.parse(readFileSync(cacheFile(), 'utf8'));
    return cache[configDir]?.account ?? null;
  } catch {
    return null; // no cache, or a corrupt one, is simply a miss
  }
}

/**
 * @returns {Promise<{email:string, orgName:string, subscriptionType:string, key:string, configDir:string}|null>}
 */
export async function readAccount({ force = false, env = process.env } = {}) {
  // The config dir selects the credential set, so it is part of the cache key.
  const configDir = env.CLAUDE_CONFIG_DIR || '(default)';
  let cache = {};
  try {
    if (existsSync(cacheFile())) cache = JSON.parse(readFileSync(cacheFile(), 'utf8'));
  } catch { /* treat a corrupt cache as empty */ }

  const cached = cache[configDir];
  if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.account;

  let account = null;
  try {
    const status = await runAuthStatus({ env });
    if (status?.loggedIn && status.email) {
      account = {
        email: status.email,
        orgId: status.orgId ?? null,
        orgName: status.orgName ?? null,
        subscriptionType: status.subscriptionType ?? null,
        authMethod: status.authMethod ?? null,
        configDir,
      };
      account.key = accountKey(account);
    }
  } catch { /* not logged in, or an older CLI without `auth status` */ }

  try {
    if (!existsSync(BLAUDE_HOME)) mkdirSync(BLAUDE_HOME, { recursive: true });
    cache[configDir] = { at: Date.now(), account };
    writeFileSync(cacheFile(), JSON.stringify(cache, null, 2));
  } catch { /* caching is an optimisation */ }

  return account;
}

/**
 * A gateway serves exactly one account's policy, so a second account needs its
 * own. Derived deterministically from the account key so the same account always
 * lands on the same port.
 */
export function portForAccount(basePort, account) {
  if (!account?.key) return basePort;
  const offset = parseInt(account.key.slice(0, 4), 16) % 200;
  return basePort + offset;
}

export function describeAccount(account) {
  if (!account) return 'not signed in';
  const plan = account.subscriptionType ? ` · ${account.subscriptionType}` : '';
  const org = account.orgName ? ` · ${account.orgName}` : '';
  return `${account.email}${plan}${org}`;
}
