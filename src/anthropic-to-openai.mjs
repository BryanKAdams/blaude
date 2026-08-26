// Anthropic Messages API request -> OpenAI chat.completions request.
//
// The tricky parts, all of which Claude Code exercises constantly:
//   * `system` may be a string or an array of cache-controlled blocks
//   * tool_result blocks live inside a *user* message but must become
//     standalone OpenAI `tool` messages
//   * images arrive base64-in-blocks and leave as data: URLs
//   * an assistant turn with only tool_use must send content: null

export class TranslateError extends Error {
  constructor(message, { status = 400, type = 'invalid_request_error' } = {}) {
    super(message);
    this.status = status;
    this.type = type;
  }
}

const asArray = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

export function flattenSystem(system) {
  if (!system) return '';
  if (typeof system === 'string') return system;
  return asArray(system)
    .filter((b) => b && (b.type === 'text' || typeof b.text === 'string'))
    .map((b) => b.text)
    .join('\n\n');
}

function imagePart(block) {
  const src = block.source || {};
  if (src.type === 'base64') {
    const mediaType = src.media_type || 'image/png';
    return { type: 'image_url', image_url: { url: `data:${mediaType};base64,${src.data}` } };
  }
  if (src.type === 'url' && src.url) return { type: 'image_url', image_url: { url: src.url } };
  return null;
}

/** tool_result content is string | blocks; OpenAI tool messages want a string. */
function toolResultToText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  const out = [];
  for (const block of asArray(content)) {
    if (typeof block === 'string') out.push(block);
    else if (block?.type === 'text') out.push(block.text ?? '');
    else if (block?.type === 'image') out.push('[image returned by tool — see following message]');
    else if (block != null) out.push(JSON.stringify(block));
  }
  return out.join('\n');
}

function collectToolResultImages(content) {
  return asArray(content)
    .filter((b) => b && b.type === 'image')
    .map(imagePart)
    .filter(Boolean);
}

export function convertMessages(messages, { thinking = 'strip' } = {}) {
  const out = [];

  for (const msg of asArray(messages)) {
    if (!msg || !msg.role) continue;
    const blocks = typeof msg.content === 'string'
      ? [{ type: 'text', text: msg.content }]
      : asArray(msg.content);

    if (msg.role === 'user') {
      // tool_result blocks break out into their own `tool` messages, in order.
      const parts = [];
      const trailingImages = [];
      for (const block of blocks) {
        if (!block) continue;
        if (block.type === 'tool_result') {
          out.push({
            role: 'tool',
            tool_call_id: block.tool_use_id,
            content: toolResultToText(block.content) || (block.is_error ? 'Error' : 'OK'),
          });
          trailingImages.push(...collectToolResultImages(block.content));
          continue;
        }
        if (block.type === 'text') {
          if (block.text) parts.push({ type: 'text', text: block.text });
        } else if (block.type === 'image') {
          const p = imagePart(block);
          if (p) parts.push(p);
        } else if (block.type === 'document') {
          parts.push({ type: 'text', text: `[document: ${block.source?.media_type || 'unknown'}]` });
        }
      }
      parts.push(...trailingImages);
      if (parts.length) out.push({ role: 'user', content: simplify(parts) });
      continue;
    }

    if (msg.role === 'assistant') {
      const textPieces = [];
      const toolCalls = [];
      for (const block of blocks) {
        if (!block) continue;
        if (block.type === 'text') {
          if (block.text) textPieces.push(block.text);
        } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
          if (thinking === 'text' && block.thinking) textPieces.push(block.thinking);
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
          });
        }
      }
      const text = textPieces.join('\n');
      if (!text && !toolCalls.length) continue;
      const m = { role: 'assistant', content: text || null };
      if (toolCalls.length) m.tool_calls = toolCalls;
      out.push(m);
      continue;
    }

    // Anything else (a `system` role smuggled into messages) is passed as text.
    const text = blocks.map((b) => b?.text ?? '').join('\n');
    if (text) out.push({ role: 'system', content: text });
  }

  return out;
}

/**
 * Ollama's chat templates generally require system messages to appear first.
 * Recent Claude Code builds can put a system-role message in the middle of the
 * conversation (for example, an updated list of available agent types). Keep
 * the content, but coalesce every system message into one leading message so a
 * strict template does not reject the entire request.
 */
export function mergeSystemMessages(initialSystem, messages) {
  const system = [initialSystem, ...messages
    .filter((m) => m?.role === 'system')
    .map((m) => m.content)]
    .filter((text) => typeof text === 'string' && text.trim())
    .join('\n\n');
  const rest = messages.filter((m) => m?.role !== 'system');
  return system ? [{ role: 'system', content: system }, ...rest] : rest;
}

/** A single text part is nicer to servers as a plain string. */
function simplify(parts) {
  if (parts.length === 1 && parts[0].type === 'text') return parts[0].text;
  return parts;
}

export function convertTools(tools) {
  return asArray(tools)
    .filter((t) => t && t.name)
    .map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema || t.parameters || { type: 'object', properties: {} },
      },
    }));
}

export function convertToolChoice(choice) {
  if (!choice) return undefined;
  switch (choice.type) {
    case 'auto': return 'auto';
    case 'any': return 'required';
    case 'none': return 'none';
    case 'tool': return { type: 'function', function: { name: choice.name } };
    default: return undefined;
  }
}

/**
 * @param {import('./wire-types.mjs').AnthropicRequest} body  Anthropic /v1/messages request body
 * @param {import('./wire-types.mjs').Route} route resolved route from router.resolveModel
 * @returns {import('./wire-types.mjs').OpenAIRequest}
 */
export function anthropicToOpenAI(body, route, cfg = {}) {
  if (!body || typeof body !== 'object') throw new TranslateError('Request body must be a JSON object');
  if (!Array.isArray(body.messages)) throw new TranslateError('"messages" must be an array');

  const messages = [];
  const system = flattenSystem(body.system);
  messages.push(...mergeSystemMessages(system, convertMessages(body.messages, { thinking: cfg.thinking })));

  if (!messages.some((m) => m.role !== 'system')) {
    throw new TranslateError('Request contains no user or assistant content');
  }

  const maxOutput = Math.min(
    body.max_tokens || route.maxOutput || 4096,
    route.maxOutput || body.max_tokens || 4096,
  );

  const req = {
    model: route.model,
    messages,
    max_tokens: maxOutput,
    stream: Boolean(body.stream),
  };

  const temperature = body.temperature ?? route.temperature;
  if (temperature != null) req.temperature = temperature;
  if (body.top_p != null) req.top_p = body.top_p;
  if (body.top_k != null) req.top_k = body.top_k;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) req.stop = body.stop_sequences;

  const tools = convertTools(body.tools);
  if (tools.length) {
    req.tools = tools;
    const tc = convertToolChoice(body.tool_choice);
    if (tc) req.tool_choice = tc;
  }

  if (req.stream) req.stream_options = { include_usage: true };

  return req;
}
