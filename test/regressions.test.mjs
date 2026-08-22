// Regressions for defects found in audit. Each one shipped in a module the rest
// of the suite did not reach: claude-cli.mjs had no tests at all, the cmd*
// handlers had none beyond their pure helpers, and fit-context was checked for
// "brought under budget" without ever being checked for "did not overshoot".
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'blaude-regression-'));
process.env.BLAUDE_HOME = HOME;
// claude-usage.mjs resolves the transcript root at import time; point it at an
// empty directory so the allowance meter reads nothing real.
process.env.BLAUDE_CLAUDE_PROJECTS = mkdtempSync(join(tmpdir(), 'blaude-transcripts-'));

const { escalateViaCLI } = await import('../src/claude-cli.mjs');
const { normalizePolicy, parseFloor, NEVER } = await import('../src/policy.mjs');
const { fitToContext } = await import('../src/fit-context.mjs');
const { toOllamaRequest } = await import('../src/ollama-backend.mjs');
const { SSEParser } = await import('../src/stream.mjs');
const { loadConfig } = await import('../src/config.mjs');
const { cmdGuard, localSessionEnv, localSessionEnvKeys } = await import('../src/cli.mjs');
const { createGateway } = await import('../src/server.mjs');
const { DEFAULTS } = await import('../src/config.mjs');

/** A stand-in `claude` that answers but reports no usage, as an older CLI does. */
function fakeClaude(body = 'Here is the answer.') {
  const path = join(mkdtempSync(join(tmpdir(), 'blaude-bin-')), 'claude');
  writeFileSync(path, `#!/bin/sh\ncat >/dev/null\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

test('an escalation whose CLI reports no usage still returns a message', async () => {
  // The usage fallback reached for `prompt`, a variable that belonged to another
  // function, so this threw a ReferenceError — discarding an answer Claude had
  // already been paid for.
  const result = await escalateViaCLI(
    { model: 'sonnet', messages: [{ role: 'user', content: 'hello' }] },
    { bin: fakeClaude('echo "Here is the answer."'), lean: false },
  );
  assert.equal(result.message.content[0].text, 'Here is the answer.');
  assert.ok(result.message.usage.input_tokens > 0, 'input tokens fall back to an estimate of what we sent');
  assert.ok(result.message.usage.output_tokens > 0);
});

test('one percent is spelled 1%, and does not collapse onto the never sentinel', () => {
  assert.equal(parseFloor('1%'), 0.01);
  assert.equal(parseFloor('20%'), 0.2);
  assert.equal(parseFloor(20), 0.2);
  assert.equal(parseFloor(0.2), 0.2);
  // A bare 1 stays NEVER: every mode preset and every config `blaude init`
  // writes depends on it, so the percent sign is what disambiguates.
  assert.equal(parseFloor(1), NEVER);
  assert.equal(parseFloor('never'), NEVER);
  assert.equal(parseFloor(null), NEVER);
  assert.equal(parseFloor(100), NEVER);

  const p = normalizePolicy({ mode: 'claude-first', floors: { audit: '1%' } });
  assert.equal(p.floors.audit, 0.01);
  assert.ok(p.floors.audit < NEVER, 'audits still reach Claude at a 1% floor');
});

test('a bad floor is rejected with the spellings that would have worked', () => {
  assert.throws(() => normalizePolicy({ floors: { audit: 'soon' } }), /number, a percentage, or "never"/);
});

test('fitting stops at the budget instead of stripping tools it had room for', () => {
  const tools = Array.from({ length: 20 }, (_, i) => ({
    name: `Tool${i}`,
    description: `First line of tool ${i}.\n${'Second line with lots of important detail '.repeat(20)}`,
    input_schema: { type: 'object', properties: {} },
  }));
  const messages = [{ role: 'user', content: 'the task' }];
  for (let i = 0; i < 40; i++) {
    messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'Tool0', input: {} }] });
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'x'.repeat(2000) }] });
  }

  const { body, report } = fitToContext({ messages, tools, system: 'sys' }, { limit: 32768, reserveOutput: 4096 });
  assert.ok(report.after <= report.budget, 'still within budget');
  // The guard used to add toolTokens to a total that already included them, so
  // every description was trimmed on requests that already fit.
  assert.equal(report.trimmedTools, 0, 'tool descriptions survive when there is room');
  assert.ok(body.tools.every((t) => t.description.includes('Second line')), 'descriptions are intact');
  assert.ok(report.budget - report.after < 2000, 'no large slice of the budget is left unused');
});

test('a tool result reaches Ollama labelled with the tool name, not the call id', () => {
  const { messages } = toOllamaRequest({
    model: 'm',
    messages: [
      { role: 'assistant', content: null, tool_calls: [{ id: 'toolu_01ABC', type: 'function', function: { name: 'Read', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'toolu_01ABC', content: 'file contents' },
      { role: 'tool', tool_call_id: 'toolu_never_seen', content: 'orphan' },
    ],
  });
  assert.equal(messages[1].tool_name, 'Read');
  // An unrecognised id is left unlabelled rather than labelled with the id.
  assert.equal(messages[2].tool_name, undefined);
});

test('a project config layers over the home one instead of replacing it', () => {
  writeFileSync(join(HOME, 'config.json'), JSON.stringify({
    defaultModel: 'blaude',
    models: { blaude: { backend: 'ollama', model: 'my-big-model', maxContext: 65536 } },
    policy: { mode: 'claude-first' },
  }));
  const project = mkdtempSync(join(tmpdir(), 'blaude-project-'));
  writeFileSync(join(project, 'blaude.config.json'), JSON.stringify({ policy: { mode: 'local-only' } }));

  const cfg = loadConfig({ cwd: project, env: {} });
  assert.equal(cfg.policy.mode, 'local-only', 'the project file wins on what it names');
  assert.equal(cfg.models.blaude.model, 'my-big-model', 'and does not discard the rest');
  assert.equal(cfg.configSources.length, 2);
});

test('BLAUDE_CONFIG stands alone, so an isolated config stays isolated', () => {
  const only = join(mkdtempSync(join(tmpdir(), 'blaude-only-')), 'c.json');
  writeFileSync(only, JSON.stringify({ policy: { mode: 'local-only' } }));
  const cfg = loadConfig({ cwd: tmpdir(), env: { BLAUDE_CONFIG: only } });
  assert.deepEqual(cfg.configSources, [only]);
  assert.equal(cfg.models.blaude.model, 'qwen3:8b', 'falls back to defaults, not to the home config');
});

test('a native launch clears every variable a hosted session sets', () => {
  const cfg = { host: '127.0.0.1', port: 8817, defaultModel: 'blaude', models: { blaude: { maxContext: 262144 } } };
  const keys = localSessionEnvKeys(cfg);
  for (const key of Object.keys(localSessionEnv(cfg))) {
    if (/API_KEY|AUTH_TOKEN/.test(key)) continue; // credentials are not ours to clear
    assert.ok(keys.includes(key), `${key} would leak into a native Claude session`);
  }
  // Absent from the object on a small window, so it has to be named explicitly.
  assert.ok(keys.includes('CLAUDE_CODE_MAX_CONTEXT_TOKENS'));
  const small = { ...cfg, models: { blaude: { maxContext: 32768 } } };
  assert.ok(localSessionEnvKeys(small).includes('CLAUDE_CODE_MAX_CONTEXT_TOKENS'));
});

test('the guard installs into a project that has no .claude directory yet', async () => {
  const project = mkdtempSync(join(tmpdir(), 'blaude-guard-'));
  const cwd = process.cwd();
  try {
    process.chdir(project);
    await cmdGuard(['on', '--project']);
    const settings = JSON.parse(readFileSync(join(project, '.claude', 'settings.json'), 'utf8'));
    assert.equal(settings.hooks.UserPromptSubmit.length, 1);
    // And removing it leaves the file clean rather than half-populated.
    await cmdGuard(['off', '--project']);
    assert.equal(JSON.parse(readFileSync(join(project, '.claude', 'settings.json'), 'utf8')).hooks, undefined);
  } finally {
    process.chdir(cwd);
  }
});

test('the guard merges alongside hooks that are already there', async () => {
  const project = mkdtempSync(join(tmpdir(), 'blaude-guard2-'));
  mkdirSync(join(project, '.claude'));
  writeFileSync(join(project, '.claude', 'settings.json'), JSON.stringify({
    hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] },
  }));
  const cwd = process.cwd();
  try {
    process.chdir(project);
    await cmdGuard(['on', '--project']);
    const after = JSON.parse(readFileSync(join(project, '.claude', 'settings.json'), 'utf8'));
    assert.equal(after.hooks.UserPromptSubmit.length, 2);
    await cmdGuard(['off', '--project']);
    const removed = JSON.parse(readFileSync(join(project, '.claude', 'settings.json'), 'utf8'));
    assert.equal(removed.hooks.UserPromptSubmit.length, 1);
    assert.equal(removed.hooks.UserPromptSubmit[0].hooks[0].command, 'echo mine');
  } finally {
    process.chdir(cwd);
  }
});

test('a final SSE event with no blank line after it is not dropped', () => {
  const parser = new SSEParser();
  assert.deepEqual(parser.push('data: {"a":1}\n\ndata: {"b":2}'), [{ a: 1 }]);
  // The stop reason and the usage totals ride on the last chunk, so losing it
  // costs both.
  assert.deepEqual(parser.flush(), [{ b: 2 }]);
  assert.deepEqual(parser.flush(), []);
});

test('the sandbox left nothing behind in the real home', () => {
  assert.ok(existsSync(HOME));
  assert.ok(HOME.startsWith(tmpdir()));
});

// ---------------------------------------------------------------------------
// The safety net under a failed escalation.
// ---------------------------------------------------------------------------

/** Minimal stand-in for Ollama: answers /api/chat and nothing else. */
function stubOllama() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.url !== '/api/chat') {
        res.writeHead(404, { 'content-type': 'text/plain' });
        return res.end('404 page not found');
      }
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          model: 'stub', message: { role: 'assistant', content: 'local answered' },
          done: true, done_reason: 'stop', prompt_eval_count: 10, eval_count: 3,
        }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('a failed escalation falls back to the local backend, in the backend\'s own dialect', async () => {
  const backend = await stubOllama();
  const port = backend.address().port;
  // A `claude` that always fails, so the escalation cannot succeed.
  const failing = fakeClaude('echo "boom" >&2; exit 1');

  const cfg = {
    ...structuredClone(DEFAULTS),
    host: '127.0.0.1',
    port: 0,
    logLevel: 'silent',
    usageLog: join(HOME, 'fallback-usage.jsonl'),
  };
  cfg.backends.ollama.baseUrl = `http://127.0.0.1:${port}`;
  cfg.configSources = [];

  const previousBin = process.env.BLAUDE_CLAUDE_BIN;
  process.env.BLAUDE_CLAUDE_BIN = failing;
  const { server } = createGateway(cfg);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/v1/messages`;

  try {
    // `cloud/` forces the escalation regardless of what the meter believes.
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'cloud/opus', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }),
    });
    const json = await res.json();
    // It used to POST to /chat/completions, a route Ollama does not serve, so
    // the safety net answered "local fallback returned 404" every time.
    assert.equal(res.status, 200, JSON.stringify(json));
    assert.equal(json.content[0].text, 'local answered');
  } finally {
    await new Promise((r) => server.close(r));
    await new Promise((r) => backend.close(r));
    if (previousBin === undefined) delete process.env.BLAUDE_CLAUDE_BIN;
    else process.env.BLAUDE_CLAUDE_BIN = previousBin;
  }
});

test('tool descriptions are given up one at a time, not all at once', () => {
  // Enough tool documentation to blow the budget on its own, so step 3 must act.
  const tools = Array.from({ length: 24 }, (_, i) => ({
    name: `Tool${i}`,
    description: `First line of tool ${i}.\n${`Detail paragraph for tool ${i}. `.repeat(150)}`,
    input_schema: { type: 'object', properties: {} },
  }));
  const messages = [{ role: 'user', content: 'the task' }];

  const { body, report } = fitToContext({ messages, tools, system: 'sys' }, { limit: 32768, reserveOutput: 4096 });

  assert.ok(report.after <= report.budget, 'still within budget');
  assert.ok(report.trimmedTools > 0, 'it did have to trim something');
  // The whole point: stop at the budget, keep the rest of the documentation.
  assert.ok(report.trimmedTools < tools.length, `kept some descriptions (trimmed ${report.trimmedTools}/${tools.length})`);
  assert.ok(body.tools.some((t) => t.description.includes('Detail paragraph')), 'some docs survive in full');
  assert.ok(report.budget - report.after < 2000, 'no large slice of the budget is left unused');
  assert.equal(report.trimmedSystem, false, 'the system prompt is never reached');
});
