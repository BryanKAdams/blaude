// OpenAI chat.completions response -> Anthropic Messages response (non-streaming).
import { randomBytes } from 'node:crypto';
import { scanText } from './text-scanner.mjs';

export const newMessageId = () => `msg_blaude_${randomBytes(12).toString('hex')}`;
export const newToolUseId = () => `toolu_blaude_${randomBytes(12).toString('hex')}`;

/** Crude but stable token estimate, used only when upstream reports no usage. */
export function estimateTokens(value) {
  if (value == null) return 0;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return tokensFromChars(text.length);
}

/** The same estimate for callers that counted characters as they went. */
export function tokensFromChars(chars) {
  return Math.max(1, Math.ceil(chars / 3.6));
}

export function mapStopReason(finishReason, { sawToolUse = false } = {}) {
  if (sawToolUse) return 'tool_use';
  switch (finishReason) {
    case 'length': return 'max_tokens';
    case 'tool_calls':
    case 'function_call': return 'tool_use';
    case 'stop':
    case 'eos':
    case null:
    case undefined: return 'end_turn';
    case 'content_filter': return 'end_turn';
    default: return 'end_turn';
  }
}

function nativeToolBlocks(toolCalls) {
  return (toolCalls || []).map((tc) => {
    let input = {};
    const raw = tc.function?.arguments;
    if (typeof raw === 'string' && raw.trim()) {
      try { input = JSON.parse(raw); } catch { input = { __unparsed_arguments: raw }; }
    } else if (raw && typeof raw === 'object') {
      input = raw;
    }
    return { type: 'tool_use', id: tc.id || newToolUseId(), name: tc.function?.name || 'unknown', input };
  });
}

/**
 * @param {import('./wire-types.mjs').OpenAICompletion} completion OpenAI completion body
 * @param {object} [opts]
 * @param {string} [opts.requestedModel]
 * @param {'strip'|'text'} [opts.thinking]
 * @param {boolean} [opts.textToolCalls]
 * @param {number} [opts.inputTokenEstimate]
 */
export function openAIToAnthropic(completion, opts = {}) {
  const {
    requestedModel = 'blaude',
    thinking = 'strip',
    textToolCalls = true,
    inputTokenEstimate = 0,
  } = opts;

  const choice = completion?.choices?.[0] || {};
  const msg = choice.message || {};

  const rawContent = typeof msg.content === 'string'
    ? msg.content
    : Array.isArray(msg.content)
      ? /** @type {Array<string|{text?: string}>} */ (msg.content).map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('')
      : '';

  // Some servers expose reasoning on its own field instead of in <think> tags.
  const reasoningField = msg.reasoning_content || msg.reasoning || '';

  const scanned = scanText(rawContent, { thinking, textToolCalls });

  const content = [];
  const thinkingText = [reasoningField, scanned.thinking].filter(Boolean).join('');
  if (thinking === 'text' && thinkingText.trim()) {
    content.push({ type: 'text', text: thinkingText.trim() });
  }
  if (scanned.text.trim()) content.push({ type: 'text', text: scanned.text });

  const toolBlocks = [
    ...nativeToolBlocks(msg.tool_calls),
    ...scanned.toolCalls.map((c) => ({ type: 'tool_use', id: newToolUseId(), name: c.name, input: c.input })),
  ];
  content.push(...toolBlocks);

  // Anthropic requires at least one content block.
  if (!content.length) content.push({ type: 'text', text: '' });

  const usage = completion?.usage || {};
  const outputTokens = usage.completion_tokens
    ?? estimateTokens(rawContent) + toolBlocks.reduce((n, b) => n + estimateTokens(b.input), 0);

  return {
    id: completion?.id ? `msg_${String(completion.id).replace(/^chatcmpl-?/, '')}` : newMessageId(),
    type: 'message',
    role: 'assistant',
    model: requestedModel,
    content,
    stop_reason: mapStopReason(choice.finish_reason, { sawToolUse: toolBlocks.length > 0 }),
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens ?? inputTokenEstimate,
      output_tokens: outputTokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}
