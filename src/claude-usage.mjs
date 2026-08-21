// Reads REAL Claude usage off this machine.
//
// Claude Code writes one JSONL transcript per session under
// ~/.claude/projects/<slug>/<session>.jsonl, and every assistant record carries
// the exact `message.usage` the API returned. Aggregating those gives Blaude a
// true picture of what you have actually spent on Claude — including sessions
// that never went through the gateway.
//
// What this is NOT: Anthropic does not publish the server-side quota math behind
// /usage, and there is no non-interactive `claude usage` command. So this
// measures observed token consumption on this machine, and budgets are enforced
// against a ceiling you calibrate (see `blaude calibrate`) rather than against
// Anthropic's internal counter.

import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const CLAUDE_PROJECTS_DIR = process.env.BLAUDE_CLAUDE_PROJECTS
  || join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');

/** Default weights: how each token class counts toward a budget. */
export const DEFAULT_WEIGHTS = {
  input: 1,
  output: 1,
  cacheCreation: 1,
  // Cache reads are cheap on the API price sheet, so they are discounted here.
  // Anthropic has not published how they count toward subscription limits;
  // treat this as a local approximation and tune it in config.
  cacheRead: 0.1,
};

/**
 * Only genuine Claude model ids count as Claude spend.
 *
 * This matters: Claude Code writes a transcript record for every response it
 * receives, including the ones Blaude served from a local model. Blaude labels
 * those `blaude:<backend>/<model>`, so filtering to /^claude-/ keeps local
 * tokens out of your Claude budget. `<synthetic>` records (client-side
 * placeholders, e.g. cancellations) are excluded for the same reason.
 */
export function isClaudeModel(model) {
  return /^claude-/i.test(String(model || ''));
}

export function weighTokens(u, weights = DEFAULT_WEIGHTS) {
  return (u.input || 0) * (weights.input ?? 1)
    + (u.output || 0) * (weights.output ?? 1)
    + (u.cacheCreation || 0) * (weights.cacheCreation ?? 1)
    + (u.cacheRead || 0) * (weights.cacheRead ?? 0.1);
}

const emptyTotals = () => ({ requests: 0, input: 0, output: 0, cacheCreation: 0, cacheRead: 0, thinking: 0 });

function addTotals(target, u) {
  target.requests += 1;
  target.input += u.input;
  target.output += u.output;
  target.cacheCreation += u.cacheCreation;
  target.cacheRead += u.cacheRead;
  target.thinking += u.thinking;
  return target;
}

async function listTranscripts(dir, sinceMs) {
  if (!existsSync(dir)) return [];
  const out = [];
  const projects = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    const projectDir = join(dir, p.name);
    const files = await readdir(projectDir).catch(() => []);
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const full = join(projectDir, f);
      // mtime prefilter keeps this fast even with hundreds of sessions.
      if (sinceMs) {
        const s = await stat(full).catch(() => null);
        if (!s || s.mtimeMs < sinceMs) continue;
      }
      out.push({ path: full, project: p.name });
    }
  }
  return out;
}

/**
 * @param {object} opts
 * @param {number} [opts.sinceMs]  ignore records older than this (epoch ms)
 * @param {string} [opts.dir]      transcripts root
 * @param {boolean} [opts.claudeOnly] count only real claude-* models (default true)
 * @returns {Promise<{events:Array, scannedFiles:number, skippedFiles:number}>}
 */
export async function readClaudeEvents({ sinceMs = 0, dir = CLAUDE_PROJECTS_DIR, claudeOnly = true } = {}) {
  const files = await listTranscripts(dir, sinceMs ? sinceMs - 86_400_000 : 0);
  const events = [];
  const seen = new Set(); // requestId can repeat across resumed/duplicated records
  let scanned = 0;

  for (const { path, project } of files) {
    let text;
    try { text = await readFile(path, 'utf8'); } catch { continue; }
    scanned++;
    for (const line of text.split('\n')) {
      if (!line || line.indexOf('"usage"') === -1) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (rec.type !== 'assistant') continue;
      const msg = rec.message;
      const u = msg?.usage;
      if (!u) continue;

      const ts = Date.parse(rec.timestamp || '');
      if (Number.isNaN(ts) || ts < sinceMs) continue;
      if (claudeOnly && !isClaudeModel(msg.model)) continue;

      const dedupeKey = `${rec.requestId || rec.uuid}:${msg.id || ''}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      events.push({
        ts,
        model: msg.model || 'unknown',
        project,
        sessionId: rec.sessionId || rec.session_id || null,
        isSidechain: Boolean(rec.isSidechain),
        input: u.input_tokens || 0,
        output: u.output_tokens || 0,
        cacheCreation: u.cache_creation_input_tokens || 0,
        cacheRead: u.cache_read_input_tokens || 0,
        thinking: u.output_tokens_details?.thinking_tokens || 0,
        serviceTier: u.service_tier || null,
      });
    }
  }

  events.sort((a, b) => a.ts - b.ts);
  return { events, scannedFiles: scanned, totalFiles: files.length };
}

/** Sum usage inside a rolling window ending now. */
export function totalsInWindow(events, spanMs, now = Date.now()) {
  const from = spanMs === Infinity ? 0 : now - spanMs;
  const totals = emptyTotals();
  const byModel = new Map();
  for (const e of events) {
    if (e.ts < from) continue;
    addTotals(totals, e);
    addTotals(byModel.get(e.model) || byModel.set(e.model, emptyTotals()).get(e.model), e);
  }
  return { from, to: now, totals, byModel: Object.fromEntries(byModel) };
}

/**
 * Largest weighted usage seen in any window of `spanMs` across history.
 * This is what `blaude calibrate` uses to suggest a realistic ceiling: your own
 * busiest session window is a far better estimate than a number picked at random.
 */
export function peakWindow(events, spanMs, weights = DEFAULT_WEIGHTS) {
  if (!events.length) return { peak: 0, at: null };
  let best = { peak: 0, at: null };
  let start = 0;
  let running = 0;
  for (let end = 0; end < events.length; end++) {
    running += weighTokens(events[end], weights);
    while (events[end].ts - events[start].ts > spanMs) {
      running -= weighTokens(events[start], weights);
      start++;
    }
    if (running > best.peak) best = { peak: running, at: new Date(events[end].ts).toISOString() };
  }
  return best;
}

/** Convenience report used by `blaude usage`. */
export async function claudeUsageReport({ weights = DEFAULT_WEIGHTS, dir = CLAUDE_PROJECTS_DIR, windows = { '5h': 5 * 3600_000, day: 24 * 3600_000, week: 7 * 24 * 3600_000 }, now = Date.now() } = {}) {
  const oldest = Math.min(...Object.values(windows));
  const { events, scannedFiles, totalFiles } = await readClaudeEvents({
    sinceMs: now - Math.max(...Object.values(windows)),
    dir,
  });
  const report = { scannedFiles, totalFiles, windows: {}, weights };
  for (const [name, span] of Object.entries(windows)) {
    const w = totalsInWindow(events, span, now);
    report.windows[name] = {
      ...w,
      weighted: Object.values(w.byModel).reduce((n, t) => n + weighTokens(t, weights), 0),
      byModel: Object.fromEntries(
        Object.entries(w.byModel).map(([m, t]) => [m, { ...t, weighted: weighTokens(t, weights) }]),
      ),
    };
  }
  report.oldestWindowMs = oldest;
  report.events = events.length;
  return report;
}

// ---------------------------------------------------------------------------
// Ground truth: moments you actually hit a limit
// ---------------------------------------------------------------------------

/**
 * Claude Code records real 429s in its transcripts, e.g.
 *   {"error":"rate_limit","apiErrorStatus":429,
 *    "message":{"content":[{"text":"You've hit your session limit · resets 2:50pm"}]}}
 *
 * These are worth far more than any estimate: at that instant you were provably
 * at the ceiling, so the spend accumulated in the preceding window IS the
 * allotment. `blaude calibrate` anchors on these when they exist.
 */
export async function findLimitEvents({ sinceMs = 0, dir = CLAUDE_PROJECTS_DIR } = {}) {
  const files = await listTranscripts(dir, 0);
  const hits = [];
  for (const { path } of files) {
    let text;
    try { text = await readFile(path, 'utf8'); } catch { continue; }
    if (text.indexOf('"rate_limit"') === -1) continue;
    for (const line of text.split('\n')) {
      if (line.indexOf('"rate_limit"') === -1) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (rec.error !== 'rate_limit') continue;
      const ts = Date.parse(rec.timestamp || '');
      if (Number.isNaN(ts) || ts < sinceMs) continue;
      const message = (rec.message?.content || [])
        .filter((b) => b && typeof b.text === 'string')
        .map((b) => b.text)
        .join(' ');
      hits.push({
        ts,
        at: new Date(ts).toISOString(),
        kind: /weekly|week/i.test(message) ? 'weekly' : /session|hour/i.test(message) ? 'session' : 'unknown',
        message,
        status: rec.apiErrorStatus ?? 429,
      });
    }
  }
  hits.sort((a, b) => a.ts - b.ts);
  return hits;
}

/** Collapse bursts of 429s (retries) into single incidents. */
export function groupLimitIncidents(hits, gapMs = 30 * 60_000) {
  const incidents = [];
  for (const hit of hits) {
    const last = incidents[incidents.length - 1];
    if (last && hit.kind === last.kind && hit.ts - last.lastTs <= gapMs) {
      last.lastTs = hit.ts;
      last.count++;
      continue;
    }
    incidents.push({ ...hit, firstTs: hit.ts, lastTs: hit.ts, count: 1 });
  }
  return incidents;
}

/** Weighted spend in the window immediately preceding `atMs`. */
export function spendBefore(events, atMs, spanMs, weights = DEFAULT_WEIGHTS) {
  const from = atMs - spanMs;
  let total = 0;
  for (const e of events) {
    if (e.ts >= from && e.ts < atMs) total += weighTokens(e, weights);
  }
  return total;
}

/**
 * Turn real limit incidents into an allotment estimate for one window.
 * Uses the median incident: the smallest anchors can reflect a partially-consumed
 * window from a previous overrun, the largest can include a limit that had just
 * reset mid-window.
 */
export function allotmentFromIncidents(events, incidents, spanMs, weights = DEFAULT_WEIGHTS) {
  const anchors = incidents.map((i) => ({
    at: new Date(i.firstTs).toISOString(),
    spend: spendBefore(events, i.firstTs, spanMs, weights),
    count: i.count,
  })).filter((a) => a.spend > 0);
  if (!anchors.length) return null;
  const sorted = [...anchors].sort((a, b) => a.spend - b.spend);
  const median = sorted[Math.floor(sorted.length / 2)].spend;
  return { anchors, median, min: sorted[0].spend, max: sorted.at(-1).spend };
}
