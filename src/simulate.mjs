// @ts-nocheck — not yet typed. `npm test` runs `tsc --checkJs` over this repo;
// the translation layer (anthropic-to-openai, openai-to-anthropic, stream,
// text-scanner, fit-context) is clean and stays clean. This file is not, so it
// opts out rather than making the check unrunnable. Delete this line, run
// `npm run typecheck`, and fix what it says.
// Replays your real Claude usage history against a candidate policy.
//
// This is a counterfactual, done properly: when the policy would have sent a
// request to the local model, its tokens do NOT count against the Claude windows,
// so the allowance curve reflects the policy under test rather than what actually
// happened. That is what makes it useful for choosing floors.
//
// Two approximations, both stated so you can weigh them:
//   * purpose is inferred (a gap of >30s before a request looks like a human
//     typing, so it counts as `main`; back-to-back requests look like a tool loop)
//   * a request served locally is assumed to have been *satisfiable* locally.
//     Blaude cannot know whether the local model would have gotten it right.

import { readClaudeEvents, weighTokens, isClaudeModel } from './claude-usage.mjs';
import { PERIOD_MS, NEVER } from './policy.mjs';

const TURN_GAP_MS = 30_000;

/** Label each event with an inferred purpose. */
export function inferPurposes(events) {
  const lastBySession = new Map();
  return events.map((e) => {
    const prev = lastBySession.get(e.sessionId);
    lastBySession.set(e.sessionId, e.ts);
    let purpose;
    if (/haiku/i.test(e.model)) purpose = 'background';
    else if (e.isSidechain) purpose = 'tools';
    else if (prev == null || e.ts - prev > TURN_GAP_MS) purpose = 'main';
    else purpose = 'tools';
    return { ...e, purpose };
  });
}

/**
 * @param {object} opts
 * @param {object} opts.policy   normalized policy
 * @param {Array}  opts.events   usage events (chronological)
 * @returns {object} simulation result
 */
export function simulate({ policy, events }) {
  const labelled = inferPurposes(events);
  const windows = Object.entries(policy.limits)
    .filter(([, l]) => l.amount > 0)
    .map(([name, l]) => ({ name, span: PERIOD_MS[l.period], amount: l.amount, period: l.period, charged: [] }));

  const counts = { cloud: 0, local: 0 };
  const tokens = { cloud: 0, local: 0 };
  const byPurpose = {};
  const handoffs = [];
  const turnDestination = new Map(); // sessionId -> destination, for sticky turns
  let lastDestination = null;

  for (const e of labelled) {
    const cost = policy.unit === 'requests' ? 1 : weighTokens(e, policy.weights);
    const floor = policy.floors?.[e.purpose] ?? NEVER;

    // Remaining allowance at this instant, given only what we charged to Claude.
    let tightest = null;
    for (const w of windows) {
      const from = e.ts - w.span;
      w.charged = w.charged.filter((c) => c.ts >= from);
      const spent = w.charged.reduce((n, c) => n + c.cost, 0);
      const fractionRemaining = Math.max(0, 1 - spent / w.amount);
      if (!tightest || fractionRemaining < tightest.fractionRemaining) {
        tightest = { name: w.name, fractionRemaining, spent, amount: w.amount };
      }
    }

    let destination;
    const sticky = policy.handoff?.stickyTurns && e.purpose !== 'main'
      ? turnDestination.get(e.sessionId)
      : null;

    if (sticky && !(sticky === 'cloud' && tightest && tightest.fractionRemaining <= (policy.handoff.hardStopFraction ?? 0))) {
      destination = sticky;
    } else if (floor >= NEVER || !windows.length) {
      destination = 'local';
    } else {
      destination = tightest && tightest.fractionRemaining > floor ? 'cloud' : 'local';
    }

    if (e.purpose === 'main') turnDestination.set(e.sessionId, destination);

    if (destination === 'cloud') {
      for (const w of windows) w.charged.push({ ts: e.ts, cost });
      counts.cloud++;
      tokens.cloud += cost;
    } else {
      counts.local++;
      tokens.local += cost;
    }

    byPurpose[e.purpose] = byPurpose[e.purpose] || { cloud: 0, local: 0 };
    byPurpose[e.purpose][destination]++;

    if (lastDestination && lastDestination !== destination) {
      handoffs.push({ at: new Date(e.ts).toISOString(), from: lastDestination, to: destination, purpose: e.purpose, remaining: tightest?.fractionRemaining ?? null });
    }
    lastDestination = destination;
  }

  const total = counts.cloud + counts.local || 1;
  return {
    requests: counts,
    tokens,
    byPurpose,
    handoffs,
    cloudShareOfRequests: counts.cloud / total,
    cloudShareOfTokens: tokens.cloud / (tokens.cloud + tokens.local || 1),
    events: labelled.length,
    span: labelled.length ? { from: new Date(labelled[0].ts).toISOString(), to: new Date(labelled.at(-1).ts).toISOString() } : null,
  };
}

export async function loadHistory({ days = 7 } = {}) {
  const { events } = await readClaudeEvents({ sinceMs: Date.now() - days * 86_400_000 });
  return events.filter((e) => isClaudeModel(e.model));
}
