import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitToContext, describeFit, selectTools, CORE_TOOLS } from '../src/fit-context.mjs';

/** A long agent session: big system prompt, many tools, fat tool outputs. */
function bigSession({ turns = 10 } = {}) {
  return {
    model: 'blaude',
    max_tokens: 4096,
    system: [{ type: 'text', text: 'SYSTEM '.repeat(2000) }],
    tools: Array.from({ length: 12 }, (_, i) => ({
      name: `Tool${i}`,
      description: `First line.\n${'detail '.repeat(300)}`,
      input_schema: { type: 'object' },
    })),
    messages: [
      { role: 'user', content: 'the original task statement' },
      ...Array.from({ length: turns }, (_, i) => [
        { role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'Tool1', input: { i } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'OUTPUT '.repeat(3000) }] },
      ]).flat(),
      { role: 'user', content: 'now finish it' },
    ],
  };
}

function orphanCount(body) {
  const ids = new Set();
  for (const m of body.messages) {
    if (m.role !== 'assistant') continue;
    for (const b of Array.isArray(m.content) ? m.content : []) if (b.type === 'tool_use') ids.add(b.id);
  }
  let orphans = 0;
  for (const m of body.messages) {
    if (m.role !== 'user' || !Array.isArray(m.content)) continue;
    for (const b of m.content) if (b.type === 'tool_result' && !ids.has(b.tool_use_id)) orphans++;
  }
  return orphans;
}

test('an oversized request is brought under budget', () => {
  const { body, report } = fitToContext(bigSession(), { limit: 16386, reserveOutput: 4096 });
  assert.ok(report.fitted);
  assert.ok(report.after <= report.budget, `${report.after} should be <= ${report.budget}`);
  assert.ok(report.before > report.after * 2, 'should be a substantial reduction');
  assert.equal(orphanCount(body), 0, 'a tool_result must never lose its tool_use');
});

test('the task statement and the newest turn both survive', () => {
  const { body } = fitToContext(bigSession({ turns: 20 }), { limit: 12000 });
  assert.match(JSON.stringify(body.messages[0].content), /original task statement/);
  assert.match(JSON.stringify(body.messages.at(-1).content), /now finish it/);
});

test('trimming is explained rather than silent', () => {
  const { report } = fitToContext(bigSession(), { limit: 16386 });
  const description = describeFit(report);
  assert.match(description, /tok/);
  assert.ok(report.truncatedResults > 0 || report.droppedMessages > 0);
});

test('a request that already fits is returned untouched', () => {
  const small = { model: 'x', messages: [{ role: 'user', content: 'hi' }] };
  const { body, report } = fitToContext(small, { limit: 32768 });
  assert.equal(report.fitted, false);
  assert.equal(body, small, 'the exact same object should come back');
  assert.equal(describeFit(report), null);
});

test('no limit means no trimming', () => {
  const { report } = fitToContext(bigSession(), { limit: null });
  assert.equal(report.fitted, false);
});

test('a brutal limit still yields a structurally valid request', () => {
  const { body, report } = fitToContext(bigSession({ turns: 30 }), { limit: 6000, reserveOutput: 1000 });
  assert.ok(report.after <= report.budget);
  assert.equal(orphanCount(body), 0);
  assert.ok(body.messages.length >= 1, 'must not empty the conversation');
  assert.ok(report.trimmedSystem || report.trimmedTools || report.droppedMessages);
});

// ---------------------------------------------------------------------------
// Tool selection
// ---------------------------------------------------------------------------

const claudeCodeTools = () => [
  { name: 'Read', description: 'read a file' },
  { name: 'Edit', description: 'edit a file' },
  { name: 'Bash', description: 'run a command' },
  { name: 'Skill', description: 'run a slash command' },
  { name: 'Workflow', description: 'W'.repeat(20000) },
  { name: 'DesignSync', description: 'D'.repeat(8000) },
  { name: 'Agent', description: 'A'.repeat(8000) },
  { name: 'mcp__github__create_pr', description: 'open a pull request' },
];

test('orchestration tools are dropped and the coding core is kept', () => {
  const { tools, report } = selectTools(claudeCodeTools(), { mode: 'core' });
  const names = tools.map((t) => t.name);
  assert.ok(names.includes('Read') && names.includes('Edit') && names.includes('Bash'));
  assert.deepEqual(report.dropped.sort(), ['Agent', 'DesignSync', 'Workflow', 'mcp__github__create_pr'].sort());
  assert.ok(report.savedTokens > 8000, `saved a real amount (${report.savedTokens})`);
});

test('Skill survives, because dropping it breaks every slash command', () => {
  // Blaude ships /bhandoff, /claudit and /bstatus; they run through Skill.
  const { tools } = selectTools(claudeCodeTools(), { mode: 'core' });
  assert.ok(tools.some((t) => t.name === 'Skill'));
  assert.ok(CORE_TOOLS.includes('ToolSearch'), 'deferred tools stay reachable too');
});

test('`also` keeps extra tools by glob, and mode "all" disables the filter', () => {
  const kept = selectTools(claudeCodeTools(), { mode: 'core', also: ['mcp__github__*'] }).tools;
  assert.ok(kept.some((t) => t.name === 'mcp__github__create_pr'));

  const untouched = selectTools(claudeCodeTools(), { mode: 'all' });
  assert.equal(untouched.tools.length, 8);
  assert.equal(untouched.report.dropped.length, 0);
});

test('an allowlist that matches nothing is treated as misconfiguration, not disarmament', () => {
  // A coding agent with zero tools is worse than a slow one.
  const { tools, report } = selectTools(claudeCodeTools(), { mode: 'core', allow: ['NoSuchTool'] });
  assert.equal(tools.length, 8, 'every tool is kept');
  assert.equal(report.dropped.length, 0);
});

test('filtering tools leaves room the context fitter would otherwise have taken', () => {
  const body = bigSession({ turns: 10 });
  body.tools = claudeCodeTools();
  const before = fitToContext(structuredClone(body), { limit: 32768 }).report;

  const filtered = { ...body, tools: selectTools(body.tools, { mode: 'core' }).tools };
  const after = fitToContext(filtered, { limit: 32768 }).report;

  assert.ok(after.before < before.before, 'the request starts smaller');
  assert.ok(after.trimmedTools <= before.trimmedTools, 'and needs no more trimming than before');
});
