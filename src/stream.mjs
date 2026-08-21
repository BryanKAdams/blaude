// OpenAI streaming chunks -> Anthropic Messages SSE events.
//
// Anthropic's event contract, which the Claude Code client validates:
//   message_start
//   ( content_block_start -> content_block_delta* -> content_block_stop )*
//   message_delta   (carries stop_reason + final output token count)
//   message_stop
//
// Blocks are opened lazily, and a tool block always closes before the next one
// opens, so index ordering stays monotonic.
import { newMessageId, newToolUseId, estimateTokens, mapStopReason } from './openai-to-anthropic.mjs';
import { TextScanner } from './text-scanner.mjs';

export class AnthropicSSEBuilder {
  constructor({
    requestedModel = 'blaude',
    messageId = newMessageId(),
    inputTokens = 0,
    thinking = 'strip',
    textToolCalls = true,
  } = {}) {
    this.requestedModel = requestedModel;
    this.messageId = messageId;
    this.inputTokens = inputTokens;
    this.thinking = thinking;
    this.scanner = new TextScanner({ thinking, textToolCalls });

    this.started = false;
    this.stopped = false;
    this.nextIndex = 0;
    this.openBlock = null;         // {kind:'text'|'tool', index}
    this.nativeTools = new Map();  // openai tool index -> {blockIndex, argsBuffer, name, opened}
    this.sawToolUse = false;
    this.finishReason = null;
    this.usage = null;
    this.outputChars = 0;
    this.toolArgChars = 0;
  }

  // --- event helpers ---------------------------------------------------------
  #start() {
    if (this.started) return [];
    this.started = true;
    return [{
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: this.messageId,
          type: 'message',
          role: 'assistant',
          model: this.requestedModel,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: this.inputTokens, output_tokens: 0 },
        },
      },
    }];
  }

  #closeBlock() {
    if (!this.openBlock) return [];
    const index = this.openBlock.index;
    this.openBlock = null;
    return [{ event: 'content_block_stop', data: { type: 'content_block_stop', index } }];
  }

  #openText() {
    if (this.openBlock?.kind === 'text') return [];
    const events = this.#closeBlock();
    const index = this.nextIndex++;
    this.openBlock = { kind: 'text', index };
    events.push({
      event: 'content_block_start',
      data: { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
    });
    return events;
  }

  #emitText(text) {
    if (!text) return [];
    this.outputChars += text.length;
    const events = this.#openText();
    events.push({
      event: 'content_block_delta',
      data: { type: 'content_block_delta', index: this.openBlock.index, delta: { type: 'text_delta', text } },
    });
    return events;
  }

  /** A complete tool call discovered in the text stream. */
  #emitWholeToolUse({ name, input }) {
    const events = this.#closeBlock();
    const index = this.nextIndex++;
    const json = JSON.stringify(input ?? {});
    this.sawToolUse = true;
    this.toolArgChars += json.length;
    events.push(
      {
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index,
          content_block: { type: 'tool_use', id: newToolUseId(), name, input: {} },
        },
      },
      {
        event: 'content_block_delta',
        data: { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json } },
      },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index } },
    );
    return events;
  }

  // --- main entry points ----------------------------------------------------
  /** @param {object} chunk a parsed OpenAI SSE `data:` payload */
  pushChunk(chunk) {
    const events = [];
    if (!chunk || typeof chunk !== 'object') return events;

    if (chunk.usage) this.usage = chunk.usage;

    const choice = chunk.choices?.[0];
    if (!choice) return events;
    const delta = choice.delta || {};

    events.push(...this.#start());

    // Reasoning delivered on a dedicated field rather than in <think> tags.
    const reasoning = delta.reasoning_content ?? delta.reasoning;
    if (reasoning && this.thinking === 'text') events.push(...this.#emitText(reasoning));

    const textPiece = typeof delta.content === 'string'
      ? delta.content
      : Array.isArray(delta.content)
        ? delta.content.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('')
        : '';

    if (textPiece) {
      const scanned = this.scanner.feed(textPiece);
      if (this.thinking === 'text' && scanned.thinking) events.push(...this.#emitText(scanned.thinking));
      if (scanned.text) events.push(...this.#emitText(scanned.text));
      for (const call of scanned.toolCalls) events.push(...this.#emitWholeToolUse(call));
    }

    for (const tc of delta.tool_calls || []) {
      events.push(...this.#pushNativeToolDelta(tc));
    }

    if (choice.finish_reason) this.finishReason = choice.finish_reason;
    return events;
  }

  #pushNativeToolDelta(tc) {
    const key = tc.index ?? 0;
    let state = this.nativeTools.get(key);
    if (!state) {
      state = { blockIndex: null, argsBuffer: '', name: '', id: null, opened: false };
      this.nativeTools.set(key, state);
    }
    if (tc.id) state.id = tc.id;
    if (tc.function?.name) state.name += tc.function.name;

    const events = [];
    // Open the block only once we know the tool's name.
    if (!state.opened && state.name) {
      events.push(...this.#closeBlock());
      state.blockIndex = this.nextIndex++;
      state.opened = true;
      this.sawToolUse = true;
      this.openBlock = { kind: 'tool', index: state.blockIndex };
      events.push({
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: state.blockIndex,
          content_block: { type: 'tool_use', id: state.id || newToolUseId(), name: state.name, input: {} },
        },
      });
      if (state.argsBuffer) {
        events.push(...this.#toolArgDelta(state, state.argsBuffer));
        state.argsBuffer = '';
      }
    }

    const argPiece = tc.function?.arguments;
    if (typeof argPiece === 'string' && argPiece) {
      if (state.opened) events.push(...this.#toolArgDelta(state, argPiece));
      else state.argsBuffer += argPiece; // arguments before the name; hold them
    }
    return events;
  }

  #toolArgDelta(state, partial) {
    this.toolArgChars += partial.length;
    return [{
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: state.blockIndex,
        delta: { type: 'input_json_delta', partial_json: partial },
      },
    }];
  }

  /** Flush held-back text, close blocks, and emit the terminal events. */
  finish() {
    if (this.stopped) return [];
    this.stopped = true;
    const events = [...this.#start()];

    const tail = this.scanner.flush();
    if (this.thinking === 'text' && tail.thinking) events.push(...this.#emitText(tail.thinking));
    if (tail.text) events.push(...this.#emitText(tail.text));
    for (const call of tail.toolCalls) events.push(...this.#emitWholeToolUse(call));

    // A tool block whose arguments never arrived still needs to be well-formed.
    for (const state of this.nativeTools.values()) {
      if (!state.opened && (state.name || state.argsBuffer)) {
        events.push(...this.#emitWholeToolUse({
          name: state.name || 'unknown',
          input: safeParse(state.argsBuffer),
        }));
      }
    }

    events.push(...this.#closeBlock());

    if (!this.nextIndex) {
      // Never produced a block: emit an empty text block so the message is valid.
      events.push(...this.#openText(), ...this.#closeBlock());
    }

    const outputTokens = this.usage?.completion_tokens
      ?? estimateTokens('x'.repeat(this.outputChars + this.toolArgChars));

    events.push(
      {
        event: 'message_delta',
        data: {
          type: 'message_delta',
          delta: {
            stop_reason: mapStopReason(this.finishReason, { sawToolUse: this.sawToolUse }),
            stop_sequence: null,
          },
          usage: {
            input_tokens: this.usage?.prompt_tokens ?? this.inputTokens,
            output_tokens: outputTokens,
          },
        },
      },
      { event: 'message_stop', data: { type: 'message_stop' } },
    );
    return events;
  }

  stats() {
    return {
      inputTokens: this.usage?.prompt_tokens ?? this.inputTokens,
      outputTokens: this.usage?.completion_tokens
        ?? estimateTokens('x'.repeat(this.outputChars + this.toolArgChars)),
      sawToolUse: this.sawToolUse,
      stopReason: mapStopReason(this.finishReason, { sawToolUse: this.sawToolUse }),
    };
  }
}

function safeParse(s) {
  if (!s) return {};
  try { return JSON.parse(s); } catch { return { __unparsed_arguments: s }; }
}

export function serializeSSE(event) {
  return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

/** Incremental parser for an upstream OpenAI SSE byte stream. */
export class SSEParser {
  constructor() { this.buf = ''; }
  /** @returns {Array<object|'[DONE]'>} */
  push(text) {
    this.buf += text;
    const out = [];
    let idx;
    while ((idx = this.buf.indexOf('\n\n')) !== -1) {
      const raw = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 2);
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload) continue;
        if (payload === '[DONE]') { out.push('[DONE]'); continue; }
        try { out.push(JSON.parse(payload)); } catch { /* ignore malformed keep-alives */ }
      }
    }
    return out;
  }
}

/**
 * Turn a complete Anthropic message into the SSE event sequence a streaming
 * client expects. Used when a cloud escalation returns in one piece but the
 * caller asked for a stream.
 */
export function syntheticSSE(message) {
  const events = [{
    event: 'message_start',
    data: {
      type: 'message_start',
      message: { ...message, content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: message.usage?.input_tokens ?? 0, output_tokens: 0 } },
    },
  }];

  message.content.forEach((block, index) => {
    if (block.type === 'text') {
      events.push(
        { event: 'content_block_start', data: { type: 'content_block_start', index, content_block: { type: 'text', text: '' } } },
        { event: 'content_block_delta', data: { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text || '' } } },
        { event: 'content_block_stop', data: { type: 'content_block_stop', index } },
      );
    } else if (block.type === 'tool_use') {
      events.push(
        { event: 'content_block_start', data: { type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } } },
        { event: 'content_block_delta', data: { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) } } },
        { event: 'content_block_stop', data: { type: 'content_block_stop', index } },
      );
    }
  });

  events.push(
    { event: 'message_delta', data: { type: 'message_delta',
      delta: { stop_reason: message.stop_reason || 'end_turn', stop_sequence: null },
      usage: { input_tokens: message.usage?.input_tokens ?? 0, output_tokens: message.usage?.output_tokens ?? 0 } } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  );
  return events;
}
