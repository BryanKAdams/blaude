import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TextScanner, scanText, parseToolCallPayload } from '../src/text-scanner.mjs';

/** Feed one character at a time — the worst case for sentinel detection. */
function streamChars(input, opts) {
  const s = new TextScanner(opts);
  let text = '';
  let thinking = '';
  const toolCalls = [];
  for (const ch of input) {
    const r = s.feed(ch);
    text += r.text; thinking += r.thinking; toolCalls.push(...r.toolCalls);
  }
  const f = s.flush();
  return { text: text + f.text, thinking: thinking + f.thinking, toolCalls: [...toolCalls, ...f.toolCalls] };
}

const CASES = [
  '<think>plan</think>visible<tool_call>{"name":"Read","arguments":{"p":"a"}}</tool_call>tail',
  'no sentinels at all',
  'a<tool_call>{"name":"A","arguments":{}}</tool_call>b<tool_call>{"name":"B","parameters":{"x":1}}</tool_call>c',
  'unterminated <tool_call>{"name":"Edit","arguments":{"n":2}}',
  'prose with a bare < and a stray </think> in it',
  '<thinking>alt tag</thinking>after',
];

test('character-by-character streaming matches one-shot parsing', () => {
  for (const input of CASES) {
    for (const thinking of ['strip', 'text']) {
      const once = scanText(input, { thinking });
      const streamed = streamChars(input, { thinking });
      assert.deepEqual(streamed, once, `mismatch for ${JSON.stringify(input)} (${thinking})`);
    }
  }
});

test('no sentinel, partial or whole, ever leaks downstream', () => {
  for (const input of CASES) {
    const streamed = streamChars(input, { thinking: 'strip' });
    assert.ok(
      !/<\/?think(?:ing)?>|<\/?tool_call>|<\/?tool_use>|<\/?function_call>/.test(streamed.text),
      `leaked a sentinel: ${streamed.text}`,
    );
  }
});

test('an orphan closing think tag is dropped, keeping the prose around it', () => {
  const r = scanText('before </think> after', { thinking: 'strip' });
  assert.equal(r.text, 'before  after');
});

test('a closing tag split across chunks is still matched', () => {
  const s = new TextScanner({});
  const out = [];
  for (const chunk of ['<tool_call>{"name":"Read",', '"arguments":{}}</too', 'l_call>done']) {
    const r = s.feed(chunk);
    out.push(r);
  }
  const f = s.flush();
  const calls = [...out.flatMap((r) => r.toolCalls), ...f.toolCalls];
  const text = out.map((r) => r.text).join('') + f.text;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'Read');
  assert.equal(text, 'done', 'text after a split closing tag must not be swallowed');
});

test('thinking mode controls whether reasoning is surfaced', () => {
  assert.equal(scanText('<think>hidden</think>shown', { thinking: 'strip' }).thinking, '');
  assert.equal(scanText('<think>hidden</think>shown', { thinking: 'text' }).thinking, 'hidden');
  assert.equal(scanText('<think>hidden</think>shown', { thinking: 'strip' }).text, 'shown');
});

test('tool call payloads accept the shapes models actually emit', () => {
  assert.deepEqual(parseToolCallPayload('{"name":"A","arguments":{"x":1}}'), { name: 'A', input: { x: 1 } });
  assert.deepEqual(parseToolCallPayload('{"name":"A","parameters":{"x":1}}'), { name: 'A', input: { x: 1 } });
  assert.deepEqual(parseToolCallPayload('{"name":"A","arguments":"{\\"x\\":1}"}'), { name: 'A', input: { x: 1 } });
  assert.deepEqual(parseToolCallPayload('noise {"name":"A","arguments":{}} trailing'), { name: 'A', input: {} });
  assert.equal(parseToolCallPayload('{"no_name":1}'), null);
  assert.equal(parseToolCallPayload(''), null);
});

test('text tool calls can be disabled entirely', () => {
  const r = scanText('x<tool_call>{"name":"A","arguments":{}}</tool_call>', { textToolCalls: false });
  assert.equal(r.toolCalls.length, 0);
  assert.match(r.text, /tool_call/, 'with parsing off the text is passed through verbatim');
});
