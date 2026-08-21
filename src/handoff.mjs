// Hand a Claude session over to the local model — for free.
//
// Every Claude Code session is already on disk as JSONL under
// ~/.claude/projects/<slug>/<session>.jsonl. Reading it costs nothing: no API
// call, no tokens, and it works with zero allowance left. That makes it the right
// way to continue Claude's work locally after the week runs out — better than
// `/resume`, which reloads the whole conversation into a live session.
//
// The digest is built structurally rather than by asking a model to summarise:
// user turns verbatim (they are the intent), assistant prose trimmed, tool calls
// as one-liners, tool outputs dropped except for errors and tails. A 400k-token
// session compresses to something a 32k-context local model can actually hold.

import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync, mkdirSync, appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { CLAUDE_PROJECTS_DIR } from './claude-usage.mjs';
import { BLAUDE_HOME, ensureHome } from './config.mjs';

/** Claude Code's directory naming: /Users/me/foo -> -Users-me-foo */
export function projectSlug(cwd) {
  return cwd.replace(/\//g, '-');
}

export async function listSessions({ cwd = process.cwd(), limit = 15, allProjects = false } = {}) {
  const root = CLAUDE_PROJECTS_DIR;
  if (!existsSync(root)) return [];
  const wanted = projectSlug(cwd);
  const dirs = (await readdir(root, { withFileTypes: true }).catch(() => []))
    .filter((d) => d.isDirectory())
    .filter((d) => allProjects || d.name === wanted || d.name.startsWith(wanted));

  const sessions = [];
  for (const d of dirs) {
    const dir = join(root, d.name);
    for (const file of await readdir(dir).catch(() => [])) {
      if (!file.endsWith('.jsonl')) continue;
      const path = join(dir, file);
      const st = await stat(path).catch(() => null);
      if (!st) continue;
      sessions.push({ path, project: d.name, sessionId: file.replace(/\.jsonl$/, ''), mtime: st.mtimeMs, bytes: st.size });
    }
  }
  sessions.sort((a, b) => b.mtime - a.mtime);

  const out = [];
  for (const s of sessions.slice(0, limit)) {
    out.push({ ...s, ...(await sessionSummary(s.path)) });
  }
  return out;
}

async function sessionSummary(path) {
  let text;
  try { text = await readFile(path, 'utf8'); } catch { return {}; }
  const lines = text.split('\n').filter(Boolean);
  let firstUser = null;
  let slug = null;
  let turns = 0;
  let toolCalls = 0;
  const models = new Set();
  for (const line of lines) {
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.slug) slug = rec.slug;
    if (rec.type === 'user' && !firstUser) {
      const c = rec.message?.content;
      const t = typeof c === 'string' ? c : (c || []).filter((b) => b?.type === 'text').map((b) => b.text).join(' ');
      if (t && !t.startsWith('<')) { firstUser = t.slice(0, 160); turns++; }
    } else if (rec.type === 'user') turns++;
    else if (rec.type === 'assistant') {
      if (rec.message?.model) models.add(rec.message.model);
      for (const b of rec.message?.content || []) if (b?.type === 'tool_use') toolCalls++;
    }
  }
  return { firstUser, slug, records: lines.length, turns, toolCalls, models: [...models] };
}

/**
 * Compact a session transcript into a briefing the local model can hold.
 * @returns {Promise<{text:string, stats:object}>}
 */
export async function digestSession(path, {
  maxChars = 24_000,
  maxAssistantChars = 700,
  maxToolResultChars = 300,
  includeToolResults = false,
} = {}) {
  const text = await readFile(path, 'utf8');
  const lines = text.split('\n').filter(Boolean);

  const parts = [];
  const filesTouched = new Set();
  const commands = [];
  let userTurns = 0;
  let assistantTurns = 0;

  for (const line of lines) {
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }

    if (rec.type === 'user') {
      const c = rec.message?.content;
      const blocks = typeof c === 'string' ? [{ type: 'text', text: c }] : (c || []);
      for (const b of blocks) {
        if (b?.type === 'text' && b.text && !b.text.startsWith('<')) {
          userTurns++;
          parts.push({ kind: 'user', text: b.text.trim() });
        } else if (b?.type === 'tool_result' && includeToolResults) {
          const t = typeof b.content === 'string' ? b.content : (b.content || []).map((x) => x?.text ?? '').join('\n');
          if (b.is_error) parts.push({ kind: 'error', text: t.slice(0, maxToolResultChars) });
        }
      }
      continue;
    }

    if (rec.type !== 'assistant') continue;
    for (const b of rec.message?.content || []) {
      if (b?.type === 'text' && b.text?.trim()) {
        assistantTurns++;
        parts.push({ kind: 'assistant', text: b.text.trim().slice(0, maxAssistantChars) });
      } else if (b?.type === 'tool_use') {
        const input = b.input || {};
        const target = input.file_path || input.path || input.pattern || input.command || '';
        if (input.file_path || input.path) filesTouched.add(String(input.file_path || input.path));
        if (b.name === 'Bash' && input.command) commands.push(String(input.command).slice(0, 120));
        parts.push({ kind: 'tool', text: `${b.name}${target ? ` ${String(target).slice(0, 120)}` : ''}` });
      }
    }
  }

  // Keep the opening intent and the most recent activity; squeeze the middle.
  const header = [];
  header.push('# Handoff briefing from a Claude session');
  header.push('');
  header.push('Claude did the work below in an earlier session. You are continuing it locally.');
  header.push('Do not restart the task or re-plan from scratch. Ask to re-read any file you need;');
  header.push('the file contents are NOT included here, only the shape of what happened.');
  header.push('');
  if (filesTouched.size) {
    header.push(`## Files touched (${filesTouched.size})`);
    header.push([...filesTouched].slice(0, 40).map((f) => `- ${f}`).join('\n'));
    header.push('');
  }
  if (commands.length) {
    header.push('## Commands run (last 10)');
    header.push(commands.slice(-10).map((c) => `- \`${c}\``).join('\n'));
    header.push('');
  }

  const rendered = parts.map((p) => {
    if (p.kind === 'user') return `\n**User:** ${p.text}`;
    if (p.kind === 'assistant') return `\n_Claude:_ ${p.text}`;
    if (p.kind === 'error') return `\n> tool error: ${p.text}`;
    return `  · ${p.text}`;
  });

  let body = rendered.join('\n');
  const budget = Math.max(2000, maxChars - header.join('\n').length);
  let elided = 0;
  if (body.length > budget) {
    // Opening third for intent, closing two-thirds for current state.
    const head = Math.floor(budget * 0.3);
    const tail = budget - head;
    elided = body.length - budget;
    body = `${body.slice(0, head)}\n\n…[${elided} characters of middle history omitted]…\n\n${body.slice(body.length - tail)}`;
  }

  return {
    text: `${header.join('\n')}## Conversation\n${body}\n`,
    stats: {
      records: lines.length,
      userTurns,
      assistantTurns,
      toolCalls: parts.filter((p) => p.kind === 'tool').length,
      filesTouched: filesTouched.size,
      sourceChars: text.length,
      digestChars: header.join('\n').length + body.length,
      elidedChars: elided,
    },
  };
}

// ---------------------------------------------------------------------------
// Blaude-side notes: a scratchpad that survives the handoff
// ---------------------------------------------------------------------------

const NOTES_DIR = () => join(BLAUDE_HOME, 'notes');
const notesFile = (cwd) => join(NOTES_DIR(), `${projectSlug(cwd).replace(/^-/, '')}.md`);

export function appendNote(text, { cwd = process.cwd() } = {}) {
  ensureHome();
  if (!existsSync(NOTES_DIR())) mkdirSync(NOTES_DIR(), { recursive: true });
  const file = notesFile(cwd);
  appendFileSync(file, `- ${new Date().toISOString()} — ${text}\n`);
  return file;
}

export function readNotes({ cwd = process.cwd() } = {}) {
  const file = notesFile(cwd);
  if (!existsSync(file)) return null;
  try { return readFileSync(file, 'utf8'); } catch { return null; }
}
