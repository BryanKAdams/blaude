#!/usr/bin/env node
// Three ways to get the same task done, measured against each other.
//
//   A  claude-direct   native Claude Code, no Blaude in the path (baseline)
//   B  blaude-relay    Blaude in the path, policy routes every turn to Claude
//   C  local-audit     the local model does the work, then Claude reviews once
//
// Claude spend is measured from Claude Code's own transcripts (the authoritative
// per-request usage) by collecting claude-* records inside each arm's window, so
// escalation subprocesses are counted too. Weighted the same way Blaude weights
// a budget: cache reads at 0.1.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { readClaudeEvents, weighTokens, DEFAULT_WEIGHTS } from '../src/claude-usage.mjs';

const ROOT = process.env.BENCH_DIR || '/tmp/blaude-bench';
const BLAUDE = new URL('../bin/blaude.mjs', import.meta.url).pathname;

const FIXTURE = {
  'src/auth.py': 'def login(u,p):\n    # TODO: rate limit this\n    return u=="admin"\n\ndef logout(s):\n    # TODO: invalidate server-side\n    s.clear()\n',
  'src/cart.py': 'def total(items):\n    # TODO: handle discounts\n    return sum(i.price for i in items)\n\ndef add(c,i):\n    c.append(i)  # TODO: check stock\n    return c\n',
  'src/util.py': 'def slugify(s):\n    return s.lower().replace(" ","-")\n',
  'src/api.py': 'def get(p):\n    # TODO: retries\n    return {"path":p}\n\ndef post(p,b):\n    # TODO: validate body\n    # TODO: auth check\n    return {"ok":True}\n',
};
const TRUTH = { total: 7, most: 'api.py' };
const TASK = 'Count every TODO comment in the .py files under src/, then say which file has the most. '
  + 'Reply in exactly two lines: "TOTAL: <n>" and "MOST: <filename>". Use Glob and Read only.';

function setup() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(`${ROOT}/src`, { recursive: true });
  for (const [rel, body] of Object.entries(FIXTURE)) writeFileSync(`${ROOT}/${rel}`, body);
}

function run(cmd, args, { env = {}, cwd = ROOT, input = null, timeoutMs = 900_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: e.message }); });
    if (input != null) child.stdin.end(input); else child.stdin.end();
  });
}

/**
 * Session IDs that already exist, so an arm's spend can be attributed to the
 * sessions IT created rather than to everything happening on the machine.
 *
 * Without this the measurement is contaminated by whatever else is running —
 * including the Claude Code session driving the benchmark, whose Opus turns carry
 * hundreds of thousands of cache-read tokens each and dwarf the arm under test.
 */
async function sessionsBefore(sinceMs) {
  const { events } = await readClaudeEvents({ sinceMs });
  return new Set(events.map((e) => e.sessionId).filter(Boolean));
}

/** Claude tokens spent by sessions this arm started. */
async function claudeSpend(fromMs, toMs, known) {
  const { events } = await readClaudeEvents({ sinceMs: fromMs - 1000 });
  const inWindow = events.filter((e) => e.ts >= fromMs && e.ts <= toMs + 5000
    && e.sessionId && !known.has(e.sessionId));
  const byModel = {};
  let weighted = 0;
  for (const e of inWindow) {
    weighted += weighTokens(e, DEFAULT_WEIGHTS);
    const m = (byModel[e.model] ||= { requests: 0, input: 0, output: 0, cacheCreation: 0, cacheRead: 0 });
    m.requests++; m.input += e.input; m.output += e.output;
    m.cacheCreation += e.cacheCreation; m.cacheRead += e.cacheRead;
  }
  return { weighted: Math.round(weighted), requests: inWindow.length, byModel };
}

function grade(text) {
  const total = /TOTAL:\s*(\d+)/i.exec(text || '');
  const most = /MOST:\s*([\w./-]+)/i.exec(text || '');
  return {
    total: total ? Number(total[1]) : null,
    most: most ? most[1].replace(/^.*\//, '') : null,
    totalOk: total ? Number(total[1]) === TRUTH.total : false,
    mostOk: most ? most[1].replace(/^.*\//, '') === TRUTH.most : false,
  };
}

const result = (r) => { try { return JSON.parse(r.out.trim().split('\n').filter((l) => l.startsWith('{')).pop() || '{}'); } catch { return {}; } };

async function armA() {
  const known = await sessionsBefore(Date.now() - 7 * 86_400_000);
  const t0 = Date.now();
  const r = await run('claude', ['-p', '--model', process.env.BENCH_MODEL || 'sonnet',
    '--output-format', 'json', '--allowedTools', 'Read,Glob'],
    { env: { ANTHROPIC_BASE_URL: undefined, ANTHROPIC_API_KEY: undefined }, input: TASK });
  const t1 = Date.now();
  const j = result(r);
  return { name: 'A claude-direct', ms: t1 - t0, text: j.result || r.out, turns: j.num_turns ?? null, spend: await claudeSpend(t0, t1, known) };
}

async function armB() {
  const known = await sessionsBefore(Date.now() - 7 * 86_400_000);
  const t0 = Date.now();
  const r = await run('node', [BLAUDE, '-p', '--output-format', 'json', '--allowedTools', 'Read,Glob'], { input: TASK });
  const t1 = Date.now();
  const j = result(r);
  return { name: 'B blaude-relay', ms: t1 - t0, text: j.result || r.out, turns: j.num_turns ?? null, spend: await claudeSpend(t0, t1, known) };
}

/**
 * The mode you would actually run in claude-audits: no Claude at all.
 *
 * The interesting columns here are correctness and wall clock — Claude spend is
 * zero by construction, which is the whole point.
 */
async function armD() {
  const known = await sessionsBefore(Date.now() - 7 * 86_400_000);
  const t0 = Date.now();
  const r = await run('node', [BLAUDE, '--local', '-p', '--output-format', 'json', '--allowedTools', 'Read,Glob'], { input: TASK });
  const t1 = Date.now();
  const j = result(r);
  // Each assistant turn, so a per-turn reviewer can see the work unfold.
  const turnTexts = [];
  try {
    const { readFileSync, readdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const dir = join(process.env.HOME, '.claude', 'projects', ROOT.replace(/\//g, '-'));
    const newest = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ f, t: readFileSync(join(dir, f), 'utf8') }))
      .sort((a, b) => b.t.length - a.t.length)[0];
    for (const line of (newest?.t || '').split('\n')) {
      if (!line.includes('"assistant"')) continue;
      try {
        const rec = JSON.parse(line);
        const text = (rec.message?.content || []).map((b) =>
          b.type === 'text' ? b.text : b.type === 'tool_use' ? `[called ${b.name} ${JSON.stringify(b.input)}]` : '').join(' ').trim();
        if (text) turnTexts.push(text.slice(0, 1500));
      } catch { /* skip */ }
    }
  } catch { /* transcript is a bonus, not required */ }
  return { name: 'D local-only', ms: t1 - t0, text: j.result || r.out, turns: j.num_turns ?? null,
    turnTexts, spend: await claudeSpend(t0, t1, known) };
}

/**
 * The arrangement this project is actually for: the local model does every turn,
 * and one persistent Claude session reviews each response as it happens —
 * accumulating context, receiving only what is new.
 *
 * Implemented as a replay of arm D's turns so the (slow) local work is not paid
 * for twice. Review cost is what a live inline reviewer would spend.
 */
async function armE(localArm) {
  const known = await sessionsBefore(Date.now() - 7 * 86_400_000);
  const t0 = Date.now();
  const { escalateViaCLI, resetRelaySessions } = await import('../src/claude-cli.mjs');
  resetRelaySessions();

  const turns = localArm?.turnTexts?.length ? localArm.turnTexts : [String(localArm?.text || '')];
  const key = 'bench-reviewer';
  let verdicts = [];
  let corrected = null;

  for (let i = 0; i < turns.length; i++) {
    const body = {
      model: 'claude-sonnet-5',
      max_tokens: 1024,
      system: 'You are reviewing another model\'s work on a task, one turn at a time. '
        + `The task: ${TASK}\n`
        + 'For each turn, reply either "APPROVE" or "CORRECT: <the corrected two lines>". Be terse.',
      messages: [{ role: 'user', content: `Turn ${i + 1} of the local model's work:\n\n${turns[i]}` }],
    };
    const r = await escalateViaCLI(body, {
      model: process.env.BENCH_MODEL || 'sonnet', shape: 'oracle', sessionKey: key, cwd: ROOT,
    });
    const text = r.message.content.map((b) => b.text || '').join('');
    verdicts.push({ turn: i + 1, reused: r.reusedSession, text: text.trim().slice(0, 120) });
    if (/CORRECT/i.test(text)) corrected = text;
  }
  const t1 = Date.now();
  return {
    name: 'E local+reviewer',
    ms: (localArm?.ms || 0) + (t1 - t0),
    reviewMs: t1 - t0,
    text: corrected || localArm?.text || '',
    verdicts,
    localText: localArm?.text,
    spend: await claudeSpend(t0, t1, known),
  };
}

async function armC(localArm = null) {
  const known = await sessionsBefore(Date.now() - 7 * 86_400_000);
  const t0 = Date.now();
  // 1. the local model does the work — or reuse a completed local run, so the
  //    (slow) local pass is not paid for once per arm.
  let localAnswer;
  let tLocal;
  if (localArm?.text) {
    localAnswer = localArm.text;
    tLocal = t0;
  } else {
    const local = await run('node', [BLAUDE, '--local', '-p', '--output-format', 'json', '--allowedTools', 'Read,Glob'], { input: TASK });
    const localJson = result(local);
    localAnswer = localJson.result || local.out;
    tLocal = Date.now();
  }

  // 2. Claude reviews that answer once
  const audit = await run('node', [BLAUDE, 'audit', '--force', '--model', process.env.BENCH_MODEL || 'sonnet',
    `${TASK}\n\nThe local model answered:\n${localAnswer}\n\nVerify the count yourself and give the corrected two lines.`]);
  const t1 = Date.now();
  return {
    name: 'C local+audit',
    ms: (localArm?.ms || 0) + (t1 - t0),
    auditMs: t1 - tLocal,
    text: audit.out, localText: localAnswer,
    reusedLocal: Boolean(localArm?.text),
    spend: await claudeSpend(t0, t1, known),
  };
}

const C_DIM = '\x1b[90m';
const C_OFF = '\x1b[0m';
const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));

setup();
const WANT = (process.env.BENCH_ARMS || 'ABC').toUpperCase();
const ORDER = [['A', armA], ['B', armB], ['C', armC], ['D', armD], ['E', armE]];
const chosen = ORDER.filter(([k]) => WANT.includes(k));
const arms = [];
let localArm = null;
for (const [key, fn] of chosen) {
  const a = (key === 'E' || key === 'C') ? await fn(localArm) : await fn();
  if (key === 'D') localArm = a;
  a.grade = grade(a.text);
  arms.push(a);
  console.error(`  done: ${a.name} (${(a.ms / 1000).toFixed(1)}s, ${fmt(a.spend.weighted)} weighted)`);
}

console.log('');
console.log(`  ground truth: TOTAL ${TRUTH.total}, MOST ${TRUTH.most}`);
console.log('');
console.log(`  ${'arm'.padEnd(17)}${'claude tok'.padStart(11)}${'requests'.padStart(10)}${'wall'.padStart(9)}${'total'.padStart(8)}${'most'.padStart(10)}`);
console.log(`  ${'-'.repeat(65)}`);
for (const a of arms) {
  console.log(`  ${a.name.padEnd(17)}${fmt(a.spend.weighted).padStart(11)}${String(a.spend.requests).padStart(10)}` +
    `${(a.ms / 1000).toFixed(1).padStart(8)}s${(a.grade.totalOk ? 'ok' : `${a.grade.total}`).padStart(8)}` +
    `${(a.grade.mostOk ? 'ok' : `${a.grade.most}`).padStart(10)}`);
}
console.log('');
for (const a of arms) {
  const models = Object.entries(a.spend.byModel).map(([m, v]) => `${m} x${v.requests}`).join(', ') || 'none';
  console.log(`  ${a.name}: ${models}`);
}
console.log('');
console.log('  what each arm actually replied:');
for (const a of arms) {
  const oneLine = String(a.text || '').replace(/\s+/g, ' ').trim().slice(0, 150);
  console.log(`    ${a.name}: ${oneLine || '(empty)'}`);
  if (a.auditMs != null) {
    console.log(`      local pass: ${a.reusedLocal ? 'reused from arm D' : 'run fresh'} · audit itself took ${(a.auditMs / 1000).toFixed(1)}s`);
  }
  if (a.verdicts) {
    for (const v of a.verdicts) {
      console.log(`      review turn ${v.turn} (${v.reused ? 'resumed' : 'new'} session): ${v.text}`);
    }
  }
  if (a.localText) {
    const lg = grade(a.localText);
    const before = String(a.localText).replace(/\s+/g, ' ').trim().slice(0, 110);
    console.log(`      local model alone: ${lg.totalOk && lg.mostOk ? 'CORRECT' : `total ${lg.total} / most ${lg.most}`}  ${C_DIM}${before}${C_OFF}`);
    console.log(`      after the audit  : ${a.grade.totalOk && a.grade.mostOk ? 'CORRECT' : `total ${a.grade.total} / most ${a.grade.most}`}`);
    console.log(`      audit ${lg.totalOk === a.grade.totalOk && lg.mostOk === a.grade.mostOk ? 'left the answer unchanged' : 'CHANGED the answer'}`);
  }
}

const base = arms[0].spend.weighted || 1;
console.log('');
for (const a of arms.slice(1)) {
  const pct = Math.round((a.spend.weighted / base) * 100);
  console.log(`  ${a.name} used ${pct}% of the Claude tokens arm A used`);
}
