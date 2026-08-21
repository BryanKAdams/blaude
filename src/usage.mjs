// Append-only usage log + aggregation. Lets you see what stayed local.
import { appendFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

export function recordUsage(cfg, entry) {
  if (!cfg.usageLog) return;
  try {
    const dir = dirname(cfg.usageLog);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    // Fire and forget: usage accounting must never delay a response.
    appendFile(cfg.usageLog, JSON.stringify(entry) + '\n').catch(() => {});
  } catch { /* logging is best-effort */ }
}

export async function readUsage(cfg) {
  if (!cfg.usageLog || !existsSync(cfg.usageLog)) return [];
  const text = await readFile(cfg.usageLog, 'utf8');
  return text.split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

/**
 * Aggregate the log. Dollar figures appear only if the user filled in a
 * `pricing` table in their config — Blaude does not ship guessed rates.
 */
export function summarize(entries, pricing = {}) {
  const byTarget = new Map();
  let localIn = 0, localOut = 0, cloudIn = 0, cloudOut = 0, requests = 0, errors = 0;

  for (const e of entries) {
    requests++;
    if (e.error) errors++;
    const key = `${e.backend}/${e.upstreamModel}`;
    const agg = byTarget.get(key) || { requests: 0, inputTokens: 0, outputTokens: 0, ms: 0, cloud: !!e.cloud };
    agg.requests++;
    agg.inputTokens += e.inputTokens || 0;
    agg.outputTokens += e.outputTokens || 0;
    agg.ms += e.ms || 0;
    byTarget.set(key, agg);

    if (e.cloud) { cloudIn += e.inputTokens || 0; cloudOut += e.outputTokens || 0; }
    else { localIn += e.inputTokens || 0; localOut += e.outputTokens || 0; }
  }

  const summary = {
    requests,
    errors,
    local: { inputTokens: localIn, outputTokens: localOut },
    cloud: { inputTokens: cloudIn, outputTokens: cloudOut },
    byTarget: Object.fromEntries(byTarget),
  };

  // Optional: what the locally-served tokens would have cost at a given rate.
  const rate = pricing.referenceModel && pricing.rates?.[pricing.referenceModel];
  if (rate) {
    summary.avoidedCostUsd = Number(
      ((localIn / 1e6) * (rate.inputPerMTok || 0) + (localOut / 1e6) * (rate.outputPerMTok || 0)).toFixed(4),
    );
    summary.avoidedCostBasis = pricing.referenceModel;
  }
  return summary;
}
