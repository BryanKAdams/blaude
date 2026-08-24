// Fits an oversized request into a local model's real context window.
//
// The alternative is what servers do by default: accept the request and silently
// drop whatever did not fit — which is the *front* of the prompt, i.e. the system
// prompt and tool definitions. The agent then behaves like a lobotomised model
// for reasons invisible to everyone.
//
// Blaude would rather decide what goes. Priority, most protected first:
//   1. the system prompt and tool definitions (without them there is no agent)
//   2. the newest turns (the work actually in progress)
//   3. the opening user message (the task statement)
//   4. everything else, oldest first
//
// Structural validity is preserved: a tool_result is never left without its
// tool_use, because an orphan makes upstream servers reject the whole request.

import { estimateTokens } from './openai-to-anthropic.mjs';
import { flattenSystem } from './anthropic-to-openai.mjs';
import { globMatch } from './router.mjs';

const ELISION = (n) => `\n…[Blaude trimmed ${n} characters to fit the local context window]…\n`;

function blocksOf(msg) {
  return typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : (msg.content || []);
}

function messageTokens(msg) {
  return estimateTokens(msg.content) + 4;
}

function truncateMiddle(text, maxChars) {
  const s = String(text ?? '');
  if (s.length <= maxChars) return s;
  const head = Math.floor(maxChars * 0.6);
  const tail = maxChars - head;
  return s.slice(0, head) + ELISION(s.length - maxChars) + s.slice(s.length - tail);
}


/** Tools a local coding session actually reaches for. */
export const CORE_TOOLS = [
  'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
  'Bash', 'BashOutput', 'KillShell',
  'Grep', 'Glob', 'LS',
  'TodoWrite', 'ExitPlanMode',
  'WebFetch', 'WebSearch',
  // Cheap, and dropping them breaks the harness rather than the model: Skill is
  // how every slash command runs (Blaude ships /bhandoff, /claudit, /bstatus),
  // ToolSearch is the only way a deferred tool can ever be loaded, and the Task
  // pair is how a backgrounded Bash command is read back.
  'Skill', 'ToolSearch', 'TaskOutput', 'TaskStop',
];

/**
 * Names of every tool the conversation has already called.
 *
 * @param {Array<{content?: string|Array<{type?: string, name?: string}>}>} messages
 * @returns {string[]}
 */
export function toolsUsedInHistory(messages = []) {
  const used = new Set();
  for (const m of messages) {
    const blocks = typeof m?.content === 'string' ? [] : (m?.content || []);
    for (const b of blocks) {
      if (b?.type === 'tool_use' && b.name) used.add(b.name);
    }
  }
  return [...used];
}

/**
 * Drops tool definitions a local model will never call.
 *
 * Measured on a one-word prompt, Claude Code sends 7,629 tokens of system prompt
 * and 27,549 tokens of tool definitions across 25 tools — a 35,178-token floor,
 * which is larger than the whole 32k window a 27B model runs in. Tools account
 * for 78% of it, and the biggest are orchestration rather than coding: Workflow
 * alone is 5,927 tokens, roughly a minute of prefill on every single turn at the
 * ~97 tok/s these runners manage.
 *
 * Nothing here is cost-free — a dropped tool is one the model cannot call — so
 * the set is an explicit allowlist, it applies only to local routes, and what it
 * removed is logged rather than silently swallowed.
 *
 * @returns {{tools:Array|undefined, report:{dropped:string[], kept:string[], keptCount:number, savedTokens:number}}}
 */
export function selectTools(tools, { mode = 'core', allow = CORE_TOOLS, also = [], keepUsed = [] } = {}) {
  /** @type {{dropped: string[], kept: string[], keptCount: number, savedTokens: number}} */
  const report = { dropped: [], kept: [], keptCount: Array.isArray(tools) ? tools.length : 0, savedTokens: 0 };
  if (mode === 'all' || !Array.isArray(tools) || !tools.length) return { tools, report };

  // A tool the conversation has already called is never dropped. The model has
  // seen it work and will reach for it again — and a tool_use naming something
  // absent from the request fails as "No such tool available", losing the turn.
  // Dropping definitions is only safe for tools nothing has touched yet.
  const patterns = [...allow, ...also, ...keepUsed];
  /** @type {any[]} */
  const keep = [];
  for (const t of tools) {
    const name = t?.name || t?.function?.name || '';
    if (patterns.some((p) => globMatch(p, name))) { keep.push(t); report.kept.push(name || '(unnamed)'); }
    else {
      report.dropped.push(name || '(unnamed)');
      report.savedTokens += estimateTokens(t);
    }
  }
  // Never hand back an empty tool array: a coding agent with no tools is worse
  // than a slow one, and an allowlist that matches nothing is a misconfiguration
  // rather than an instruction to disarm the session.
  if (!keep.length) return { tools, report: { dropped: [], kept: [], keptCount: tools.length, savedTokens: 0 } };

  report.keptCount = keep.length;
  return { tools: keep, report };
}

/** One-line summary for the log, or null when nothing was dropped. */
export function describeToolSelection(report) {
  if (!report.dropped.length) return null;
  // The list is of what went, so say so: labelling it "kept" read as though the
  // tools named had survived, which is the opposite of what happened.
  // Name what SURVIVED. The dropped list is the long one and gets elided exactly
  // when it matters; "which tools does the model actually have" is the question
  // you are asking when a turn dies on a missing tool.
  return `${report.dropped.length} dropped, ${report.keptCount} kept `
    + `(~${report.savedTokens.toLocaleString()} tok saved) — kept: ${report.kept.join(', ')}`;
}

/**
 * @param {import('./wire-types.mjs').AnthropicRequest} body    Anthropic request body
 * @param {object} [opts]
 * @param {number} [opts.limit]        real context ceiling in tokens
 * @param {number} [opts.reserveOutput] tokens to leave for the reply
 * @param {number} [opts.maxToolResultChars]
 * @returns {{body:object, report:object}}
 */
export function fitToContext(body, {
  limit,
  reserveOutput = 4096,
  maxToolResultChars = 4000,
} = {}) {
  /** @type {{fitted: boolean, limit: number|undefined, budget: number|null, before: number, after: number, truncatedResults: number, droppedMessages: number, trimmedTools: number, trimmedSystem: boolean, orphanResultsDemoted: number}} */
  const report = {
    fitted: false, limit, budget: null,
    before: 0, after: 0,
    truncatedResults: 0, droppedMessages: 0, trimmedTools: 0, trimmedSystem: false,
    // Initialised here rather than only assigned on the path that demotes: a
    // report whose fields appear and disappear makes the log read as though the
    // step never ran when it ran and found nothing.
    orphanResultsDemoted: 0,
  };
  if (!limit || !Array.isArray(body.messages)) return { body, report };

  const budget = Math.max(1024, limit - reserveOutput);
  report.budget = budget;

  const systemTokens = estimateTokens(flattenSystem(body.system));
  let toolTokens = (body.tools || []).reduce((n, t) => n + estimateTokens(t), 0);
  let messages = body.messages.map((m) => ({ ...m }));
  const total = () => systemTokens + toolTokens + messages.reduce((n, m) => n + messageTokens(m), 0);

  report.before = total();
  if (report.before <= budget) { report.after = report.before; return { body, report }; }

  // 1. Shrink big tool results, oldest first — usually the bulk of a long session.
  for (let i = 0; i < messages.length && total() > budget; i++) {
    const msg = messages[i];
    if (msg.role !== 'user' || typeof msg.content === 'string') continue;
    let changed = false;
    const content = blocksOf(msg).map((b) => {
      if (b?.type !== 'tool_result') return b;
      const text = typeof b.content === 'string'
        ? b.content
        : (b.content || []).map((c) => c?.text ?? '').join('\n');
      if (text.length <= maxToolResultChars) return b;
      changed = true;
      report.truncatedResults++;
      return { ...b, content: truncateMiddle(text, maxToolResultChars) };
    });
    if (changed) messages[i] = { ...msg, content };
  }

  // 2. Drop the oldest turns, keeping the opening task statement and the tail.
  if (total() > budget) {
    const firstUser = messages.findIndex((m) => m.role === 'user');
    const keepHead = firstUser >= 0 ? firstUser + 1 : 0;
    while (total() > budget && messages.length > keepHead + 2) {
      messages.splice(keepHead, 1);
      report.droppedMessages++;
    }
    if (report.droppedMessages) {
      messages.splice(keepHead, 0, {
        role: 'user',
        content: [{ type: 'text', text: `[Blaude omitted ${report.droppedMessages} earlier message(s) to fit the local context window. Ask to re-read anything you need.]` }],
      });
    }
  }

  // Never leave a tool_result without the tool_use that produced it.
  const liveToolIds = new Set();
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      for (const b of blocksOf(msg)) if (b?.type === 'tool_use' && b.id) liveToolIds.add(b.id);
    }
  }
  let orphans = 0;
  messages = messages.map((msg) => {
    if (msg.role !== 'user' || typeof msg.content === 'string') return msg;
    const content = blocksOf(msg).map((b) => {
      if (b?.type !== 'tool_result' || liveToolIds.has(b.tool_use_id)) return b;
      orphans++;
      const text = typeof b.content === 'string'
        ? b.content
        : (b.content || []).map((c) => c?.text ?? '').join('\n');
      // Demote to plain text: keeps the information, loses the dangling pairing.
      return { type: 'text', text: `[earlier tool result] ${truncateMiddle(text, 600)}` };
    });
    return { ...msg, content };
  });
  report.orphanResultsDemoted = orphans;

  // 3. Trim tool descriptions to their first line. Claude Code ships long ones.
  //
  // `total()` already counts toolTokens, so the guard here must not add them
  // again: doing so trimmed every description on requests the earlier steps had
  // already brought under budget, throwing away the documentation the model needs
  // to call its tools while thousands of tokens of room sat unused.
  //
  // Trimming is incremental, biggest description first, and stops the moment the
  // request fits. Trimming the whole array at once cost far more than the overage:
  // measured on a 32k window, one over-budget request went to 18.6k against a
  // 28.7k budget — every one of 23 descriptions reduced to a single line to
  // recover tokens that then went unused. Tool docs are what a local model reads
  // to call a tool correctly, so they are given up one at a time and no faster
  // than the budget demands.
  let tools = body.tools;
  if (total() > budget && Array.isArray(tools) && tools.length) {
    tools = tools.slice();
    const retally = () => { toolTokens = (tools || []).reduce((n, t) => n + estimateTokens(t), 0); };
    // Longest first: each trim buys the most room, so fewest tools lose their docs.
    const order = tools
      .map((t, i) => ({ i, len: String(t.description || '').length }))
      .sort((a, b) => b.len - a.len);
    for (const { i } of order) {
      if (total() <= budget) break;
      const full = String(tools[i].description || '');
      const first = full.split('\n')[0];
      if (first.length >= full.length) continue; // already one line — nothing to win
      tools[i] = { ...tools[i], description: first };
      report.trimmedTools++;
      retally();
    }
  }

  // 4. Last resort: the system prompt itself.
  let system = body.system;
  const recompute = () => estimateTokens(flattenSystem(system))
    + (tools || []).reduce((n, t) => n + estimateTokens(t), 0)
    + messages.reduce((n, m) => n + messageTokens(m), 0);

  if (recompute() > budget) {
    const flat = flattenSystem(system);
    const overBy = recompute() - budget;
    const targetChars = Math.max(2000, flat.length - Math.ceil(overBy * 3.6));
    system = truncateMiddle(flat, targetChars);
    report.trimmedSystem = true;
  }

  report.after = recompute();
  report.fitted = true;
  return { body: { ...body, messages, tools, system }, report };
}

/** One-line summary for the log. */
export function describeFit(report) {
  if (!report.fitted) return null;
  const bits = [`${report.before}→${report.after} tok (limit ${report.limit})`];
  if (report.truncatedResults) bits.push(`${report.truncatedResults} tool results shortened`);
  if (report.droppedMessages) bits.push(`${report.droppedMessages} old messages dropped`);
  if (report.orphanResultsDemoted) bits.push(`${report.orphanResultsDemoted} orphan results demoted`);
  if (report.trimmedTools) bits.push(`${report.trimmedTools} tool descriptions trimmed`);
  if (report.trimmedSystem) bits.push('system prompt trimmed');
  return bits.join(' · ');
}
