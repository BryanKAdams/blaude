// Incremental scanner for the two things local models bury inside plain text:
// reasoning traces (<think>...</think>) and tool calls (<tool_call>{...}</tool_call>).
//
// It is written for streaming: feed() may be called with arbitrary chunk
// boundaries — even a single character — and it will never emit a partial
// sentinel downstream. Anything that *might* be the start of a sentinel is held
// back until the next chunk (or flush()) disambiguates it.

const THINK_OPEN = ['<think>', '<thinking>'];
const THINK_CLOSE = ['</think>', '</thinking>'];
const TOOL_OPEN = ['<tool_call>', '<tool_use>', '<function_call>'];
const TOOL_CLOSE = ['</tool_call>', '</tool_use>', '</function_call>'];

const ALL_SENTINELS = [...THINK_OPEN, ...THINK_CLOSE, ...TOOL_OPEN, ...TOOL_CLOSE];
const MAX_SENTINEL = Math.max(...ALL_SENTINELS.map((s) => s.length));

/** Earliest occurrence of any needle in haystack. */
function firstOf(haystack, needles, from = 0) {
  let best = { index: -1, needle: '' };
  for (const needle of needles) {
    const i = haystack.indexOf(needle, from);
    if (i !== -1 && (best.index === -1 || i < best.index)) best = { index: i, needle };
  }
  return best;
}

/** How many trailing chars of `buf` could still grow into a sentinel. */
function holdBack(buf) {
  const start = Math.max(0, buf.length - (MAX_SENTINEL - 1));
  for (let i = start; i < buf.length; i++) {
    const tail = buf.slice(i);
    if (ALL_SENTINELS.some((s) => s.startsWith(tail) && s.length > tail.length)) return buf.length - i;
  }
  return 0;
}

/** Turn the body of a <tool_call> block into {name, input}. */
export function parseToolCallPayload(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return null;

  /** @type {any} */
  let obj = null;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    const first = trimmed.indexOf('{');
    const last = trimmed.lastIndexOf('}');
    if (first !== -1 && last > first) {
      try { obj = JSON.parse(trimmed.slice(first, last + 1)); } catch { /* give up below */ }
    }
  }
  if (!obj || typeof obj !== 'object') return null;

  const name = obj.name || obj.tool || obj.function?.name || obj.recipient_name;
  if (!name) return null;

  let input = obj.arguments ?? obj.parameters ?? obj.input ?? obj.function?.arguments ?? {};
  if (typeof input === 'string') {
    try { input = JSON.parse(input); } catch { input = { input }; }
  }
  if (input == null || typeof input !== 'object' || Array.isArray(input)) input = { value: input };

  return { name: String(name), input };
}

export class TextScanner {
  /**
   * @param {object} [opts]
   * @param {'strip'|'text'} [opts.thinking]  what to do with reasoning traces
   * @param {boolean} [opts.textToolCalls]    parse text-embedded tool calls
   */
  constructor({ thinking = 'strip', textToolCalls = true } = {}) {
    this.thinking = thinking;
    this.textToolCalls = textToolCalls;
    this.buf = '';
    this.mode = 'text'; // 'text' | 'think' | 'tool'
  }

  get openSentinels() {
    // Stray THINK_CLOSE tags are included so an orphan closer (common when a
    // reasoning block gets truncated upstream) is swallowed rather than shown.
    const base = [...THINK_OPEN, ...THINK_CLOSE];
    return this.textToolCalls ? [...base, ...TOOL_OPEN] : base;
  }

  /**
   * @returns {{text:string, thinking:string, toolCalls:Array<{name:string,input:object}>}}
   */
  feed(chunk, { final = false } = {}) {
    this.buf += chunk ?? '';
    let text = '';
    let thinking = '';
    const toolCalls = [];

    for (;;) {
      if (this.mode === 'text') {
        const hit = firstOf(this.buf, this.openSentinels);
        if (hit.index === -1) {
          const keep = final ? 0 : holdBack(this.buf);
          text += this.buf.slice(0, this.buf.length - keep);
          this.buf = keep ? this.buf.slice(this.buf.length - keep) : '';
          break;
        }
        text += this.buf.slice(0, hit.index);
        this.buf = this.buf.slice(hit.index + hit.needle.length);
        if (THINK_CLOSE.includes(hit.needle)) continue; // orphan closer: drop it
        this.mode = THINK_OPEN.includes(hit.needle) ? 'think' : 'tool';
        continue;
      }

      if (this.mode === 'think') {
        const hit = firstOf(this.buf, THINK_CLOSE);
        if (hit.index === -1) {
          const keep = final ? 0 : holdBack(this.buf);
          const usable = this.buf.slice(0, this.buf.length - keep);
          if (this.thinking === 'text') thinking += usable;
          this.buf = keep ? this.buf.slice(this.buf.length - keep) : '';
          break;
        }
        if (this.thinking === 'text') thinking += this.buf.slice(0, hit.index);
        this.buf = this.buf.slice(hit.index + hit.needle.length);
        this.mode = 'text';
        continue;
      }

      // mode === 'tool'. The body stays in `buf` untouched so a closing tag
      // split across chunk boundaries still matches on a later feed().
      const hit = firstOf(this.buf, TOOL_CLOSE);
      if (hit.index === -1) {
        if (final) {
          // Unterminated tool call at end of stream: salvage what we have.
          const call = parseToolCallPayload(this.buf);
          if (call) toolCalls.push(call);
          this.buf = '';
          this.mode = 'text';
        }
        break;
      }
      const call = parseToolCallPayload(this.buf.slice(0, hit.index));
      if (call) toolCalls.push(call);
      this.buf = this.buf.slice(hit.index + hit.needle.length);
      this.mode = 'text';
    }

    return { text, thinking, toolCalls };
  }

  flush() {
    return this.feed('', { final: true });
  }
}

/** One-shot convenience for non-streaming responses. */
export function scanText(content, opts) {
  const s = new TextScanner(opts);
  const a = s.feed(content ?? '');
  const b = s.flush();
  return {
    text: a.text + b.text,
    thinking: a.thinking + b.thinking,
    toolCalls: [...a.toolCalls, ...b.toolCalls],
  };
}
