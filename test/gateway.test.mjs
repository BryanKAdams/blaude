import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from '../src/server.mjs';
import { DEFAULTS } from '../src/config.mjs';

// ---------------------------------------------------------------------------
// A stub that speaks Ollama's native /api/chat, so the whole gateway path runs.
// ---------------------------------------------------------------------------
let backend;
let backendUrl;
let gateway;
let gatewayUrl;
const seen = [];
let scripted = null;

function startBackend() {
  return new Promise((resolve) => {
    backend = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const body = JSON.parse(raw || '{}');
        seen.push({ url: req.url, body });

        if (scripted?.status && scripted.status !== 200) {
          res.writeHead(scripted.status, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: 'backend exploded' }));
        }

        if (body.stream) {
          res.writeHead(200, { 'content-type': 'application/x-ndjson' });
          for (const line of scripted?.stream || [
            { message: { content: 'Hello ' } },
            { message: { content: 'world' } },
            { done: true, done_reason: 'stop', prompt_eval_count: 1234, eval_count: 7 },
          ]) res.write(JSON.stringify(line) + '\n');
          return res.end();
        }

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(scripted?.body || {
          model: body.model,
          message: { role: 'assistant', content: 'plain answer' },
          done_reason: 'stop',
          prompt_eval_count: 1234,
          eval_count: 7,
        }));
      });
    }).listen(0, '127.0.0.1', () => {
      backendUrl = `http://127.0.0.1:${backend.address().port}`;
      resolve();
    });
  });
}

before(async () => {
  await startBackend();
  const cfg = {
    ...JSON.parse(JSON.stringify(DEFAULTS)),
    host: '127.0.0.1',
    port: 0,
    logLevel: 'silent',
    usageLog: join(tmpdir(), `blaude-test-${process.pid}.jsonl`),
    backends: { stub: { kind: 'ollama', baseUrl: backendUrl, apiKey: null } },
    models: {
      blaude: { backend: 'stub', model: 'stub-large', maxContext: 32768, maxOutput: 4096 },
      'blaude-small': { backend: 'stub', model: 'stub-small', maxContext: 8192, maxOutput: 1024 },
    },
    routes: [{ match: '*haiku*', model: 'blaude-small' }, { match: '*', model: 'blaude' }],
    defaultModel: 'blaude',
    // Keep the test hermetic: no /usage subprocess, no cloud.
    policy: { mode: 'local-only', source: 'gateway' },
  };
  const built = createGateway(cfg);
  gateway = built.server;
  await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
  gatewayUrl = `http://127.0.0.1:${gateway.address().port}`;
});

after(async () => {
  await new Promise((r) => gateway.close(r));
  await new Promise((r) => backend.close(r));
});

const post = (path, body) => fetch(`${gatewayUrl}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': 'blaude-local', 'anthropic-version': '2023-06-01' },
  body: JSON.stringify(body),
});

function resetStub() { scripted = null; seen.length = 0; }

/** The gateway also polls /api/ps for the real context size; ignore those. */
const chatCalls = () => seen.filter((s) => s.url === '/api/chat');

// ---------------------------------------------------------------------------

test('health and model listing answer', async () => {
  const health = await (await fetch(`${gatewayUrl}/health`)).json();
  assert.equal(health.ok, true);
  assert.equal(health.service, 'blaude');

  const models = await (await fetch(`${gatewayUrl}/v1/models`)).json();
  assert.deepEqual(models.data.map((m) => m.id).sort(), ['blaude', 'blaude-small']);
});

test('a non-streaming request returns a valid Anthropic message', async () => {
  resetStub();
  const res = await post('/v1/messages', {
    model: 'claude-sonnet-5',
    max_tokens: 100,
    system: 'be brief',
    messages: [{ role: 'user', content: 'hello' }],
  });
  assert.equal(res.status, 200);
  const msg = await res.json();
  assert.equal(msg.type, 'message');
  assert.equal(msg.role, 'assistant');
  assert.equal(msg.content[0].text, 'plain answer');
  assert.equal(msg.stop_reason, 'end_turn');
  assert.equal(msg.usage.input_tokens, 1234, 'usage should come from the backend');

  // The backend must have been addressed in its own dialect.
  const call = chatCalls()[0];
  assert.ok(call, 'a /api/chat request should have been made');
  assert.equal(call.body.model, 'stub-large');
  assert.equal(call.body.messages[0].role, 'system');
  assert.equal(call.body.options.num_ctx, 32768, 'the context request must be passed through');
});

test('a streaming request emits a well-formed Anthropic event sequence', async () => {
  resetStub();
  const res = await post('/v1/messages', {
    model: 'claude-sonnet-5', max_tokens: 100, stream: true,
    messages: [{ role: 'user', content: 'hello' }],
  });
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  assert.equal(res.headers.get('x-blaude-route'), 'stub/stub-large');

  const text = await res.text();
  const events = text.split('\n\n').filter(Boolean).map((chunk) => {
    const [ev, data] = chunk.split('\n');
    return { event: ev.replace('event: ', ''), data: JSON.parse(data.replace('data: ', '')) };
  });
  assert.equal(events[0].event, 'message_start');
  assert.equal(events.at(-1).event, 'message_stop');
  const streamed = events.filter((e) => e.event === 'content_block_delta').map((e) => e.data.delta.text).join('');
  assert.equal(streamed, 'Hello world');
  assert.equal(events.at(-2).data.usage.output_tokens, 7);
});

test('a tool call from the backend becomes a tool_use block', async () => {
  resetStub();
  scripted = {
    body: {
      model: 'stub-large',
      message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'Read', arguments: { file_path: '/tmp/x' } } }] },
      done_reason: 'stop', prompt_eval_count: 10, eval_count: 5,
    },
  };
  const msg = await (await post('/v1/messages', {
    model: 'claude-sonnet-5', max_tokens: 100,
    messages: [{ role: 'user', content: 'read it' }],
    tools: [{ name: 'Read', description: 'read a file', input_schema: { type: 'object' } }],
  })).json();

  assert.equal(msg.stop_reason, 'tool_use');
  const toolUse = msg.content.find((b) => b.type === 'tool_use');
  assert.equal(toolUse.name, 'Read');
  assert.deepEqual(toolUse.input, { file_path: '/tmp/x' });
  assert.ok(chatCalls()[0].body.tools?.length, 'tool definitions must reach the backend');
});

test('a tool call emitted as text is recovered', async () => {
  resetStub();
  scripted = {
    body: {
      model: 'stub-large',
      message: { role: 'assistant', content: 'ok <tool_call>{"name":"Bash","arguments":{"command":"ls"}}</tool_call>' },
      done_reason: 'stop', prompt_eval_count: 10, eval_count: 5,
    },
  };
  const msg = await (await post('/v1/messages', {
    model: 'claude-sonnet-5', max_tokens: 100, messages: [{ role: 'user', content: 'list files' }],
  })).json();
  assert.equal(msg.stop_reason, 'tool_use');
  assert.equal(msg.content.find((b) => b.type === 'tool_use').name, 'Bash');
});

test('haiku-class requests route to the small model', async () => {
  resetStub();
  await post('/v1/messages', { model: 'claude-haiku-4-5-20251001', max_tokens: 50, messages: [{ role: 'user', content: 'title this' }] });
  assert.equal(chatCalls()[0].body.model, 'stub-small');
});

test('token counting responds without touching the backend', async () => {
  resetStub();
  const r = await (await post('/v1/messages/count_tokens', {
    model: 'claude-sonnet-5',
    messages: [{ role: 'user', content: 'x'.repeat(3600) }],
  })).json();
  assert.ok(r.input_tokens > 500, 'should estimate a four-figure prompt');
  assert.equal(chatCalls().length, 0, 'counting must not call the model');
});

test('a backend failure becomes a clean Anthropic error', async () => {
  resetStub();
  scripted = { status: 500 };
  const res = await post('/v1/messages', { model: 'claude-sonnet-5', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(res.status, 500);
  const err = await res.json();
  assert.equal(err.type, 'error');
  assert.match(err.error.message, /stub backend error/);
});

test('malformed JSON is rejected as an invalid request', async () => {
  const res = await fetch(`${gatewayUrl}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json',
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.type, 'invalid_request_error');
});

test('unknown paths 404 with an Anthropic-shaped error', async () => {
  const res = await fetch(`${gatewayUrl}/v1/nonsense`);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error.type, 'not_found_error');
});

test('local-only mode never routes to Claude', async () => {
  resetStub();
  const status = await (await fetch(`${gatewayUrl}/blaude/status`)).json();
  assert.equal(status.mode, 'local-only');
  assert.ok(status.routing.every((r) => r.destination === 'local'));
  assert.equal(status.counters.cloud, 0);
});

test('tools that cannot work locally are withheld, with an honest note', async () => {
  resetStub();
  await post('/v1/messages', {
    model: 'claude-sonnet-5', max_tokens: 50,
    messages: [{ role: 'user', content: 'what is the latest version?' }],
    tools: [
      { name: 'WebSearch', description: 'search the web', input_schema: { type: 'object' } },
      { name: 'Read', description: 'read a file', input_schema: { type: 'object' } },
    ],
  });
  const sentTools = (chatCalls()[0].body.tools || []).map((t) => t.function?.name ?? t.name);
  assert.deepEqual(sentTools, ['Read'], 'WebSearch must not be offered to a local model');
  const system = chatCalls()[0].body.messages.find((m) => m.role === 'system')?.content || '';
  assert.match(system, /not available in this session/);
  assert.match(system, /do not invent sources/);
});
