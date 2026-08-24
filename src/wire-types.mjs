// Shapes of the two wire protocols Blaude translates between.
//
// These are JSDoc-only: nothing here is imported at runtime, and the file emits
// no code. They exist because `@param {object}` — which is what the translation
// layer used to say — declares a type with no properties at all, so under
// `checkJs` every field access on it is an error while every typo on it is
// silently fine. That is strictly worse than no annotation. Real shapes make the
// checker earn its place on the layer where a mismatch is a mangled tool call
// rather than a crash.
//
// Deliberately loose where the wire is loose: both APIs add fields faster than
// this file can track them, and Blaude passes through what it does not read.

/**
 * @typedef {object} AnthropicRequest
 * @property {Array<AnthropicMessage>} messages
 * @property {string|Array<{type?: string, text?: string}>} [system]
 * @property {string} [model]
 * @property {number} [max_tokens]
 * @property {boolean} [stream]
 * @property {number} [temperature]
 * @property {number} [top_p]
 * @property {string[]} [stop_sequences]
 * @property {Array<AnthropicTool>} [tools]
 * @property {{type: string, name?: string}} [tool_choice]
 * @property {object} [metadata]
 */

/**
 * @typedef {object} AnthropicMessage
 * @property {string} role
 * @property {string|Array<AnthropicBlock>} content
 */

/**
 * @typedef {object} AnthropicBlock
 * @property {string} [type]
 * @property {string} [text]
 * @property {string} [id]
 * @property {string} [name]
 * @property {object} [input]
 * @property {string} [tool_use_id]
 * @property {string|Array<AnthropicBlock>} [content]
 * @property {boolean} [is_error]
 * @property {string} [thinking]
 */

/**
 * @typedef {object} AnthropicTool
 * @property {string} [name]
 * @property {string} [description]
 * @property {object} [input_schema]
 * @property {{name?: string}} [function]
 */

/**
 * A route as resolved by the router: which backend and model a request goes to,
 * plus the ceilings that route imposes.
 *
 * @typedef {object} Route
 * @property {string} model
 * @property {number} [maxOutput]
 * @property {number} [maxContext]
 * @property {number} [temperature]
 * @property {string} [backend]
 * @property {string} [purpose]
 */

/**
 * @typedef {object} OpenAIRequest
 * @property {string} model
 * @property {Array<{role: string, content?: any, tool_calls?: Array<OpenAIToolCall>, tool_call_id?: string}>} messages
 * @property {number} [max_tokens]
 * @property {boolean} [stream]
 * @property {number} [temperature]
 * @property {number} [top_p]
 * @property {string[]} [stop]
 * @property {Array<object>} [tools]
 * @property {string|object} [tool_choice]
 * @property {{include_usage: boolean}} [stream_options]
 */

/**
 * @typedef {object} OpenAIToolCall
 * @property {string} [id]
 * @property {string} [type]
 * @property {{name?: string, arguments?: string}} [function]
 */

/**
 * One message or delta. `reasoning_content` and `reasoning` are both here on
 * purpose: runners disagree about which one carries thinking, so Blaude reads
 * whichever arrived.
 *
 * @typedef {object} OpenAIDelta
 * @property {string} [role]
 * @property {string|null} [content]
 * @property {string|null} [reasoning_content]
 * @property {string|null} [reasoning]
 * @property {Array<OpenAIToolCall & {index?: number}>} [tool_calls]
 */

/**
 * @typedef {object} OpenAICompletion
 * @property {string} [id]
 * @property {string} [model]
 * @property {Array<{message?: OpenAIDelta, delta?: OpenAIDelta, finish_reason?: string|null}>} [choices]
 * @property {{prompt_tokens?: number, completion_tokens?: number, total_tokens?: number}} [usage]
 */

/**
 * One Anthropic SSE event as Blaude emits it. Deliberately a single loose shape
 * rather than a discriminated union: every helper on the stream translator
 * returns an array of these and they get concatenated freely, so a union would
 * make TypeScript infer the element type from whichever helper it saw first and
 * reject every other event shape pushed into the same array.
 *
 * @typedef {object} AnthropicSSEEvent
 * @property {string} [event]
 * @property {object} [data]
 */

export {};
