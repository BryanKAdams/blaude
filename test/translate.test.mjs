import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anthropicToOpenAI, convertMessages, flattenSystem, convertTools, convertToolChoice } from '../src/anthropic-to-openai.mjs';
import { openAIToAnthropic, mapStopReason } from '../src/openai-to-anthropic.mjs';

const route = { model: 'local-model', maxOutput: 8192 };

test('flattens a cache-controlled system prompt into one string', () => {
  assert.equal(flattenSystem('plain'), 'plain');
  assert.equal(
    flattenSystem([{ type: 'text', text: 'a', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'b' }]),
    'a\n\nb',
  );
  assert.equal(flattenSystem(undefined), '');
});

test('tool_result blocks become standalone tool messages in order', () => {
  const messages = convertMessages([
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { p: 'a' } }] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'tu1', content: 'file body' },
      { type: 'text', text: 'and now?' },
    ] },
  ]);
  assert.equal(messages[0].role, 'assistant');
  assert.equal(messages[0].content, null, 'tool-only assistant turn must send null content');
  assert.equal(messages[0].tool_calls[0].function.arguments, '{"p":"a"}');
  assert.equal(messages[1].role, 'tool');
  assert.equal(messages[1].tool_call_id, 'tu1');
  assert.equal(messages[2].role, 'user');
  assert.equal(messages[2].content, 'and now?');
});

test('base64 images become data URLs and survive tool results', () => {
  const messages = convertMessages([
    { role: 'user', content: [
      { type: 'text', text: 'look' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
    ] },
  ]);
  const parts = messages[0].content;
  assert.equal(parts[1].type, 'image_url');
  assert.equal(parts[1].image_url.url, 'data:image/png;base64,QUJD');
});

test('thinking blocks are dropped by default and kept in text mode', () => {
  const input = [{ role: 'assistant', content: [
    { type: 'thinking', thinking: 'secret reasoning' },
    { type: 'text', text: 'answer' },
  ] }];
  assert.equal(convertMessages(input, { thinking: 'strip' })[0].content, 'answer');
  assert.match(convertMessages(input, { thinking: 'text' })[0].content, /secret reasoning/);
});

test('tools and tool_choice map to the OpenAI shape', () => {
  const tools = convertTools([{ name: 'Read', description: 'd', input_schema: { type: 'object' } }]);
  assert.equal(tools[0].type, 'function');
  assert.equal(tools[0].function.name, 'Read');
  assert.equal(convertToolChoice({ type: 'any' }), 'required');
  assert.equal(convertToolChoice({ type: 'none' }), 'none');
  assert.deepEqual(convertToolChoice({ type: 'tool', name: 'Read' }), { type: 'function', function: { name: 'Read' } });
  assert.equal(convertToolChoice(undefined), undefined);
});

test('max_tokens is clamped by the route ceiling', () => {
  const req = anthropicToOpenAI(
    { model: 'x', max_tokens: 999_999, messages: [{ role: 'user', content: 'hi' }] },
    { model: 'm', maxOutput: 4096 },
  );
  assert.equal(req.max_tokens, 4096);
});

test('a request with no usable content is rejected', () => {
  assert.throws(() => anthropicToOpenAI({ model: 'x', system: 'only system', messages: [] }, route), /no user or assistant content/);
});

test('stop_reason maps correctly, and text tool calls force tool_use', () => {
  assert.equal(mapStopReason('length'), 'max_tokens');
  assert.equal(mapStopReason('tool_calls'), 'tool_use');
  assert.equal(mapStopReason('stop'), 'end_turn');
  assert.equal(mapStopReason('stop', { sawToolUse: true }), 'tool_use');

  const msg = openAIToAnthropic({
    choices: [{ finish_reason: 'stop', message: { content: 'ok<tool_call>{"name":"Bash","arguments":{"command":"ls"}}</tool_call>' } }],
  }, { requestedModel: 'blaude' });
  assert.equal(msg.stop_reason, 'tool_use', 'a text-embedded tool call must not end the turn');
  assert.equal(msg.content.at(-1).type, 'tool_use');
  assert.deepEqual(msg.content.at(-1).input, { command: 'ls' });
});

test('unparseable tool arguments are preserved rather than dropped', () => {
  const msg = openAIToAnthropic({
    choices: [{ finish_reason: 'tool_calls', message: { content: '', tool_calls: [{ id: 'c', function: { name: 'X', arguments: '{broken' } }] } }],
  }, {});
  assert.equal(msg.content[0].input.__unparsed_arguments, '{broken');
});

test('an empty response still yields a valid message', () => {
  const msg = openAIToAnthropic({ choices: [{ finish_reason: 'stop', message: { content: '' } }] }, {});
  assert.equal(msg.content.length, 1);
  assert.equal(msg.content[0].type, 'text');
});
