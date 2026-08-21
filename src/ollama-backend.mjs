// Ollama's native /api/chat, adapted to look like OpenAI chat.completions.
//
// Why bother when Ollama already speaks OpenAI: only the native endpoint accepts
// `options.num_ctx`, which overrides the daemon's context cap PER REQUEST. That
// cap defaults low and truncates silently, so being able to set it per request is
// the difference between a working coding agent and a lobotomised one — with no
// daemon restart and no global config change.
//
// Everything here converts to/from the OpenAI shape so the rest of Blaude's
// translation pipeline stays unchanged.

import { randomBytes } from 'node:crypto';

const toolCallId = () => `call_${randomBytes(8).toString('hex')}`;

/** OpenAI-shaped request -> Ollama /api/chat body. */
export function toOllamaRequest(openaiReq, { numCtx = null, think = false } = {}) {
  const messages = (openaiReq.messages || []).map((m) => {
    // Ollama takes images as a sibling array of bare base64 strings.
    if (Array.isArray(m.content)) {
      const text = [];
      const images = [];
      for (const part of m.content) {
        if (part?.type === 'text') text.push(part.text);
        else if (part?.type === 'image_url') {
          const url = part.image_url?.url || '';
          const m64 = /^data:[^;]+;base64,(.*)$/.exec(url);
          if (m64) images.push(m64[1]);
        }
      }
      const out = { role: m.role, content: text.join('\n') };
      if (images.length) out.images = images;
      return out;
    }
    const out = { role: m.role, content: m.content ?? '' };
    if (m.tool_calls?.length) {
      out.tool_calls = m.tool_calls.map((tc) => ({
        function: {
          name: tc.function?.name,
          arguments: safeParseArgs(tc.function?.arguments),
        },
      }));
    }
    if (m.role === 'tool') {
      out.role = 'tool';
      if (m.tool_call_id) out.tool_name = m.tool_call_id;
    }
    return out;
  });

  const options = {};
  if (numCtx) options.num_ctx = numCtx;
  if (openaiReq.temperature != null) options.temperature = openaiReq.temperature;
  if (openaiReq.top_p != null) options.top_p = openaiReq.top_p;
  if (openaiReq.max_tokens != null) options.num_predict = openaiReq.max_tokens;
  if (openaiReq.stop) options.stop = Array.isArray(openaiReq.stop) ? openaiReq.stop : [openaiReq.stop];

  const body = {
    model: openaiReq.model,
    messages,
    stream: Boolean(openaiReq.stream),
    options,
  };
  if (openaiReq.tools?.length) body.tools = openaiReq.tools;
  // Reasoning models: keep traces out of the response unless asked for.
  if (think === false) body.think = false;
  return body;
}

function safeParseArgs(args) {
  if (args == null) return {};
  if (typeof args === 'object') return args;
  try { return JSON.parse(args); } catch { return { __unparsed_arguments: String(args) }; }
}

function mapDoneReason(reason) {
  switch (reason) {
    case 'length': return 'length';
    case 'stop': return 'stop';
    case 'load': return 'stop';
    default: return reason || 'stop';
  }
}

/** Ollama non-streaming response -> OpenAI completion. */
export function fromOllamaResponse(body) {
  const msg = body?.message || {};
  const toolCalls = (msg.tool_calls || []).map((tc) => ({
    id: toolCallId(),
    type: 'function',
    function: {
      name: tc.function?.name || 'unknown',
      arguments: JSON.stringify(tc.function?.arguments ?? {}),
    },
  }));

  return {
    id: `chatcmpl-ollama-${randomBytes(6).toString('hex')}`,
    object: 'chat.completion',
    model: body?.model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: msg.content ?? '',
        ...(msg.thinking ? { reasoning_content: msg.thinking } : {}),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: toolCalls.length ? 'tool_calls' : mapDoneReason(body?.done_reason),
    }],
    usage: {
      prompt_tokens: body?.prompt_eval_count ?? 0,
      completion_tokens: body?.eval_count ?? 0,
      total_tokens: (body?.prompt_eval_count ?? 0) + (body?.eval_count ?? 0),
    },
  };
}

/**
 * One NDJSON line from a streaming /api/chat -> OpenAI-shaped chunk(s).
 * Ollama emits complete tool calls in a single chunk rather than incrementally.
 */
export function fromOllamaChunk(obj) {
  const chunks = [];
  const msg = obj?.message || {};

  if (msg.thinking) {
    chunks.push({ choices: [{ index: 0, delta: { reasoning_content: msg.thinking }, finish_reason: null }] });
  }
  if (msg.content) {
    chunks.push({ choices: [{ index: 0, delta: { content: msg.content }, finish_reason: null }] });
  }
  if (msg.tool_calls?.length) {
    msg.tool_calls.forEach((tc, index) => {
      chunks.push({
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index,
              id: toolCallId(),
              type: 'function',
              function: { name: tc.function?.name || 'unknown', arguments: JSON.stringify(tc.function?.arguments ?? {}) },
            }],
          },
          finish_reason: null,
        }],
      });
    });
  }
  if (obj?.done) {
    chunks.push({
      choices: [{ index: 0, delta: {}, finish_reason: msg.tool_calls?.length ? 'tool_calls' : mapDoneReason(obj.done_reason) }],
      usage: {
        prompt_tokens: obj.prompt_eval_count ?? 0,
        completion_tokens: obj.eval_count ?? 0,
      },
    });
  }
  return chunks;
}

/** Incremental NDJSON parser for the streaming response. */
export class NDJSONParser {
  constructor() { this.buf = ''; }
  push(text) {
    this.buf += text;
    const out = [];
    let idx;
    while ((idx = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      try { out.push(JSON.parse(line)); } catch { /* partial or noise */ }
    }
    return out;
  }
  flush() {
    const line = this.buf.trim();
    this.buf = '';
    if (!line) return [];
    try { return [JSON.parse(line)]; } catch { return []; }
  }
}
