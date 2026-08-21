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

/**
 * @param {object} body    Anthropic request body
 * @param {object} opts
 * @param {number} opts.limit          real context ceiling in tokens
 * @param {number} [opts.reserveOutput] tokens to leave for the reply
 * @param {number} [opts.maxToolResultChars]
 * @returns {{body:object, report:object}}
 */
export function fitToContext(body, {
  limit,
  reserveOutput = 4096,
  maxToolResultChars = 4000,
} = {}) {
  const report = {
    fitted: false, limit, budget: null,
    before: 0, after: 0,
    truncatedResults: 0, droppedMessages: 0, trimmedTools: 0, trimmedSystem: false,
  };
  if (!limit || !Array.isArray(body.messages)) return { body, report };

  const budget = Math.max(1024, limit - reserveOutput);
  report.budget = budget;

  const systemTokens = estimateTokens(flattenSystem(body.system));
  const toolTokens = (body.tools || []).reduce((n, t) => n + estimateTokens(t), 0);
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
  let tools = body.tools;
  if (total() > budget && Array.isArray(tools) && tools.length) {
    tools = tools.map((t) => {
      const first = String(t.description || '').split('\n')[0];
      if (first.length < String(t.description || '').length) report.trimmedTools++;
      return { ...t, description: first };
    });
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
