// Exact allowance state, straight from Claude Code's own `/usage`.
//
// `claude -p "/usage"` runs the slash command headlessly and returns the same
// report the interactive panel shows. It is a client-side command: no API call,
// no tokens, no cost (total_cost_usd 0, duration_api_ms 0). That makes it the
// authoritative source for Blaude — no weights, no calibration, no estimating.
//
// Everything else in this codebase that infers allowance from transcripts is the
// fallback for when this command cannot be run or its format changes.

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { childEnv } from './claude-cli.mjs';
import { BLAUDE_HOME } from './config.mjs';

/** Percent-used lines, e.g. "Current week (all models): 100% used · resets Aug 24 at 1pm". */
const PATTERNS = [
  { key: 'session', re: /current session:\s*([\d.]+)\s*%\s*used(?:\s*·\s*resets\s*([^\n]+))?/i },
  { key: 'weekly', re: /current week\s*\(all models\):\s*([\d.]+)\s*%\s*used(?:\s*·\s*resets\s*([^\n]+))?/i },
];

/** Per-model weekly lines, e.g. "Current week (Opus): 42% used". */
const PER_MODEL_RE = /current week\s*\(([^)]+)\):\s*([\d.]+)\s*%\s*used(?:\s*·\s*resets\s*([^\n]+))?/gi;

export function parseUsageOutput(text) {
  const raw = String(text ?? '');
  const windows = {};

  for (const { key, re } of PATTERNS) {
    const m = re.exec(raw);
    if (!m) continue;
    windows[key] = {
      usedFraction: Math.min(1, Number(m[1]) / 100),
      fractionRemaining: Math.max(0, 1 - Number(m[1]) / 100),
      usedPercent: Number(m[1]),
      resetsAt: m[2]?.trim() || null,
    };
  }

  for (const m of raw.matchAll(PER_MODEL_RE)) {
    const label = m[1].trim();
    if (/all models/i.test(label)) continue;
    const key = `weekly-${label.toLowerCase().replace(/\s+/g, '-')}`;
    windows[key] = {
      usedFraction: Math.min(1, Number(m[2]) / 100),
      fractionRemaining: Math.max(0, 1 - Number(m[2]) / 100),
      usedPercent: Number(m[2]),
      resetsAt: m[3]?.trim() || null,
      model: label,
    };
  }

  const subscription = /using your subscription/i.test(raw);
  const requests24h = /last 24h\s*·\s*([\d,]+) requests/i.exec(raw);
  const requests7d = /last 7d\s*·\s*([\d,]+) requests/i.exec(raw);

  return {
    ok: Object.keys(windows).length > 0,
    subscription,
    windows,
    requests24h: requests24h ? Number(requests24h[1].replace(/,/g, '')) : null,
    requests7d: requests7d ? Number(requests7d[1].replace(/,/g, '')) : null,
    raw,
  };
}

/**
 * Run `/usage` headlessly.
 * @returns {Promise<ReturnType<typeof parseUsageOutput> & {durationMs:number}>}
 */
export function readUsageCommand({
  bin = process.env.BLAUDE_CLAUDE_BIN || 'claude',
  timeoutMs = 45_000,
  cwd = process.cwd(),
  env = process.env,
} = {}) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['-p', '--output-format', 'json', '/usage'], {
      cwd,
      env: childEnv(env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`/usage did not respond within ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`cannot run "${bin}": ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !out) return reject(new Error(`/usage exited ${code}: ${err.slice(0, 500)}`));
      let text = out;
      try {
        const parsed = JSON.parse(out);
        text = parsed.result ?? parsed.text ?? out;
        // A real API call here would mean this is not free any more.
        if (parsed.total_cost_usd) text += `\n(reported cost ${parsed.total_cost_usd})`;
      } catch { /* plain text output is fine */ }
      const result = parseUsageOutput(text);
      if (!result.ok) {
        return reject(new Error(
          `could not parse /usage output — the format may have changed. Raw:\n${String(text).slice(0, 400)}`,
        ));
      }
      resolve({ ...result, durationMs: Date.now() - started });
    });
  });
}

// ---------------------------------------------------------------------------
// Cached reads, for callers that must be instant
// ---------------------------------------------------------------------------

/**
 * One cache file per account. A shared file would hand one account's remaining
 * allowance to another's session — the readings look plausible and are simply
 * about the wrong subscription.
 */
const CACHE_FILE = (key = null) => join(BLAUDE_HOME, key ? `usage-cache-${key}.json` : 'usage-cache.json');

/**
 * Read `/usage` through a short-lived cache.
 *
 * The guard hook runs on every prompt submission, and a 1.1s stall before each
 * message would be intolerable. So: serve the cache when fresh; when stale,
 * serve it anyway and kick off a detached refresh for next time. Only a cold
 * cache blocks.
 *
 * @returns {Promise<{windows:object, cachedAt:number, stale:boolean}|null>}
 */
export async function readUsageCached({ ttlMs = 60_000, allowStale = true, accountKey = null } = {}) {
  let cached = null;
  try {
    if (existsSync(CACHE_FILE(accountKey))) cached = JSON.parse(readFileSync(CACHE_FILE(accountKey), 'utf8'));
  } catch { /* a corrupt cache is just a cache miss */ }

  const age = cached ? Date.now() - (cached.cachedAt || 0) : Infinity;
  if (cached && age < ttlMs) return { ...cached, stale: false };

  if (cached && allowStale) {
    refreshUsageCacheDetached();
    return { ...cached, stale: true };
  }

  const fresh = await readUsageCommand();
  writeUsageCache(fresh, accountKey);
  return { windows: fresh.windows, subscription: fresh.subscription, cachedAt: Date.now(), stale: false };
}

export function writeUsageCache(report, accountKey = null) {
  try {
    if (!existsSync(BLAUDE_HOME)) mkdirSync(BLAUDE_HOME, { recursive: true });
    writeFileSync(CACHE_FILE(accountKey), JSON.stringify({
      windows: report.windows,
      subscription: report.subscription,
      cachedAt: Date.now(),
    }));
  } catch { /* caching is an optimisation */ }
}

/** Fire-and-forget refresh so the next read is warm. */
function refreshUsageCacheDetached() {
  try {
    const child = spawn(process.execPath, [new URL('../bin/blaude.mjs', import.meta.url).pathname, 'refresh-usage'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch { /* best effort */ }
}
