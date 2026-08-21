import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicSSEBuilder, SSEParser, serializeSSE, syntheticSSE } from '../src/stream.mjs';

function collect(chunks, opts = {}) {
  const b = new AnthropicSSEBuilder({ requestedModel: 'blaude', inputTokens: 100, ...opts });
  const events = [];
  for (const c of chunks) events.push(...b.pushChunk(c));
  events.push(...b.finish());
  return { events, builder: b };
}

/** The contract Anthropic clients validate. */
function assertValidSequence(events) {
  assert.equal(events[0].event, 'message_start', 'must open with message_start');
  assert.equal(events.at(-1).event, 'message_stop', 'must close with message_stop');
  assert.equal(events.at(-2).event, 'message_delta', 'message_delta must precede message_stop');

  let open = null;
  const seen = [];
  for (const e of events) {
    if (e.event === 'content_block_start') {
      assert.equal(open, null, 'a block opened while another was still open');
      open = e.data.index;
      seen.push(e.data.index);
    } else if (e.event === 'content_block_delta') {
      assert.equal(e.data.index, open, 'delta for a block that is not open');
    } else if (e.event === 'content_block_stop') {
      assert.equal(e.data.index, open, 'stop for a block that is not open');
      open = null;
    }
  }
  assert.equal(open, null, 'a content block was left open');
  assert.deepEqual(seen, seen.map((_, i) => i), 'block indices must be sequential from 0');
}

test('text then native tool call produces a valid event sequence', () => {
  const { events } = collect([
    { choices: [{ delta: { content: 'Let me ' } }] },
    { choices: [{ delta: { content: 'read it.' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'Read', arguments: '{"p"' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"a"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 100, completion_tokens: 20 } },
  ]);
  assertValidSequence(events);
  const deltas = events.filter((e) => e.event === 'content_block_delta');
  assert.equal(deltas.filter((d) => d.data.delta.type === 'text_delta').length, 2);
  const json = deltas.filter((d) => d.data.delta.type === 'input_json_delta').map((d) => d.data.delta.partial_json).join('');
  assert.equal(json, '{"p":"a"}', 'streamed tool arguments must reassemble exactly');
  assert.equal(events.at(-2).data.delta.stop_reason, 'tool_use');
  assert.equal(events.at(-2).data.usage.output_tokens, 20);
});

test('think tags split across chunks never reach the client', () => {
  const { events } = collect([
    { choices: [{ delta: { content: '<thi' } }] },
    { choices: [{ delta: { content: 'nk>secret' } }] },
    { choices: [{ delta: { content: '</think>visible' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ]);
  assertValidSequence(events);
  const text = events.filter((e) => e.event === 'content_block_delta').map((e) => e.data.delta.text).join('');
  assert.equal(text, 'visible');
});

test('a tool call arriving as text becomes a tool_use block and flips stop_reason', () => {
  const { events } = collect([
    { choices: [{ delta: { content: 'sure<tool_call>{"name":"Bash","arguments":{"command":"ls"}}</tool_call>' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ]);
  assertValidSequence(events);
  const start = events.find((e) => e.event === 'content_block_start' && e.data.content_block.type === 'tool_use');
  assert.equal(start.data.content_block.name, 'Bash');
  assert.equal(events.at(-2).data.delta.stop_reason, 'tool_use');
});

test('a response with no content still emits one valid empty block', () => {
  const { events } = collect([{ choices: [{ delta: {}, finish_reason: 'stop' }] }]);
  assertValidSequence(events);
  assert.equal(events.filter((e) => e.event === 'content_block_start').length, 1);
});

test('tool arguments arriving before the name are not lost', () => {
  const { events } = collect([
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"x":1}' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c2', function: { name: 'Late' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ]);
  assertValidSequence(events);
  const json = events.filter((e) => e.event === 'content_block_delta').map((e) => e.data.delta.partial_json).join('');
  assert.equal(json, '{"x":1}');
});

test('two tool calls yield two separate blocks', () => {
  const { events } = collect([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'A', arguments: '{}' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 1, id: 'b', function: { name: 'B', arguments: '{}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ]);
  assertValidSequence(events);
  assert.equal(events.filter((e) => e.event === 'content_block_start').length, 2);
});

test('usage is estimated when the backend reports none', () => {
  const { builder } = collect([
    { choices: [{ delta: { content: 'x'.repeat(360) } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ]);
  assert.ok(builder.stats().outputTokens > 50, 'should estimate from character volume');
});

test('SSEParser handles arbitrary chunk boundaries and [DONE]', () => {
  const payloads = [{ a: 1 }, { b: 2 }];
  const wire = payloads.map((p) => `data: ${JSON.stringify(p)}\n\n`).join('') + 'data: [DONE]\n\n';
  const parser = new SSEParser();
  const got = [];
  for (let i = 0; i < wire.length; i += 3) got.push(...parser.push(wire.slice(i, i + 3)));
  assert.deepEqual(got, [...payloads, '[DONE]']);
});

test('malformed SSE payloads are skipped, not thrown', () => {
  const parser = new SSEParser();
  const got = parser.push('data: {bad json}\n\ndata: {"ok":1}\n\n');
  assert.deepEqual(got, [{ ok: 1 }]);
});

test('serializeSSE emits the event/data wire format', () => {
  assert.equal(serializeSSE({ event: 'ping', data: { type: 'ping' } }), 'event: ping\ndata: {"type":"ping"}\n\n');
});

test('syntheticSSE turns a whole message into a valid sequence', () => {
  const events = syntheticSSE({
    id: 'm', type: 'message', role: 'assistant', model: 'x',
    content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', id: 't', name: 'Read', input: { p: 1 } }],
    stop_reason: 'tool_use', usage: { input_tokens: 5, output_tokens: 7 },
  });
  assertValidSequence(events);
  assert.equal(events.at(-2).data.delta.stop_reason, 'tool_use');
});
