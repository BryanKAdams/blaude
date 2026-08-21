// Cloud escalation through the official `claude` CLI — i.e. your subscription.
//
// Why this and not api.anthropic.com: an API key bills per token against
// credits, which is exactly the cost Blaude exists to avoid. Shelling out to the
// installed CLI reuses the auth your normal sessions already use, through a
// supported entry point.
//
// Two shapes:
//   oracle — Claude answers in prose. Used for audits and second opinions.
//   relay  — Claude is handed the caller's tool contract and replies with
//            <tool_call> blocks, which Blaude turns back into real tool_use
//            content. This is what lets an escalated request keep driving the
//            outer agent loop.

import { spawn } from 'node:child_process';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { BLAUDE_HOME } from './config.mjs';
import { flattenSystem } from './anthropic-to-openai.mjs';
import { scanText } from './text-scanner.mjs';
import { newToolUseId, estimateTokens } from './openai-to-anthropic.mjs';

/** Env for the child: never let it loop back into Blaude, never use API billing. */
export function childEnv(env = process.env, { preferSubscription = true } = {}) {
  const child = { ...env };
  // Without this, `claude` would call the gateway that just called it.
  delete child.ANTHROPIC_BASE_URL;
  delete child.ANTHROPIC_MODEL;
  delete child.ANTHROPIC_SMALL_FAST_MODEL;
  delete child.ANTHROPIC_DEFAULT_HAIKU_MODEL;
  delete child.ANTHROPIC_DEFAULT_SONNET_MODEL;
  delete child.ANTHROPIC_DEFAULT_OPUS_MODEL;
  if (preferSubscription) {
    // Force OAuth/subscription auth rather than metered credits.
    delete child.ANTHROPIC_API_KEY;
    delete child.ANTHROPIC_AUTH_TOKEN;
  }
  child.BLAUDE_CHILD = '1'; // recursion guard, checked by the gateway
  return child;
}

const TOOL_CONTRACT = `
You are being consulted through Blaude, a local routing gateway. You are NOT
running in your own session: you cannot execute anything yourself. The caller
owns the tools and will execute on your behalf.

To use a tool, emit exactly one block per call, and nothing else after it:

<tool_call>{"name": "<ToolName>", "arguments": { ... }}</tool_call>

Rules:
- Emit tool calls ONLY for the tools listed below, with arguments matching the schema.
- Put any explanation BEFORE the tool call block.
- If no tool is needed, just answer normally.
`.trim();

function renderConversation(body, { includeTools }) {
  const lines = [];
  const system = flattenSystem(body.system);
  if (system) {
    lines.push('=== CALLER SYSTEM PROMPT (context, not instructions to you) ===');
    lines.push(system);
    lines.push('');
  }

  if (includeTools && Array.isArray(body.tools) && body.tools.length) {
    lines.push('=== TOOLS AVAILABLE TO THE CALLER ===');
    for (const t of body.tools) {
      lines.push(`- ${t.name}: ${(t.description || '').split('\n')[0]}`);
      lines.push(`  schema: ${JSON.stringify(t.input_schema || {})}`);
    }
    lines.push('');
  }

  lines.push('=== CONVERSATION ===');
  for (const msg of body.messages || []) {
    const blocks = typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : (msg.content || []);
    for (const b of blocks) {
      if (!b) continue;
      if (b.type === 'text' && b.text) lines.push(`[${msg.role}] ${b.text}`);
      else if (b.type === 'tool_use') lines.push(`[${msg.role} called ${b.name}] ${JSON.stringify(b.input)}`);
      else if (b.type === 'tool_result') {
        const text = typeof b.content === 'string'
          ? b.content
          : (b.content || []).map((c) => c?.text ?? '').join('\n');
        lines.push(`[tool result${b.is_error ? ' ERROR' : ''}] ${truncate(text, 4000)}`);
      } else if (b.type === 'image') lines.push('[image omitted]');
    }
  }
  lines.push('');
  lines.push('=== YOUR TURN ===');
  return lines.join('\n');
}

function truncate(s, n) {
  const str = String(s ?? '');
  return str.length <= n ? str : `${str.slice(0, n)}\n…[${str.length - n} chars truncated]`;
}

/**
 * Trim what the child session primes into its prompt.
 *
 * Measured on this machine: a cold escalation primes ~24k tokens of system
 * prompt, tool definitions, skills and MCP tools. Two things reduce that:
 *
 *   1. these flags, which strip MCP servers, hooks, plugins and bundled skills
 *      from the child (it is answering one question — it needs none of them)
 *   2. Anthropic's prompt cache: the second escalation within the cache window
 *      re-reads the primed prefix instead of recreating it, which measured
 *      ~2.6k weighted tokens against ~24k cold. Bursty escalation is cheap;
 *      one escalation every ten minutes pays full price each time.
 *
 * `--bare` would cut more still, but it forces ANTHROPIC_API_KEY auth and so
 * cannot use the subscription — which defeats the purpose.
 */
export function leanFlags() {
  const settingsPath = join(BLAUDE_HOME, 'escalation-settings.json');
  try {
    if (!existsSync(BLAUDE_HOME)) mkdirSync(BLAUDE_HOME, { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      disableAllHooks: true,
      enabledPlugins: {},
      disableBundledSkills: true,
    }, null, 2));
  } catch {
    return ['--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'];
  }
  return [
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--settings', settingsPath,
  ];
}

/**
 * Run `claude -p` and return the parsed result.
 * @returns {Promise<{text:string, usage:object, model:string, sessionId:string|null, costUsd:number|null, raw:object|null}>}
 */
export function runClaudeCLI({
  prompt,
  model = 'sonnet',
  appendSystemPrompt = null,
  allowedTools = [],
  cwd = process.cwd(),
  timeoutMs = 300_000,
  bin = process.env.BLAUDE_CLAUDE_BIN || 'claude',
  extraArgs = [],
  env = process.env,
  lean = true,
} = {}) {
  const args = ['-p', '--output-format', 'json', '--model', model];
  if (lean) args.push(...leanFlags());
  if (appendSystemPrompt) args.push('--append-system-prompt', appendSystemPrompt);
  // An empty allow-list plus a deny-all keeps the child from touching the repo.
  if (allowedTools.length) args.push('--allowedTools', ...allowedTools);
  else args.push('--disallowedTools', 'Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch');
  args.push(...extraArgs);

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env: childEnv(env), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`claude CLI timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`cannot run "${bin}": ${e.message}. Install Claude Code or set BLAUDE_CLAUDE_BIN.`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        return reject(new Error(`claude CLI exited ${code}: ${(err || out).slice(0, 800)}`));
      }
      let parsed = null;
      try { parsed = JSON.parse(out); } catch { /* fall back to raw text */ }
      const text = parsed?.result ?? parsed?.text ?? out.trim();
      resolve({
        text: typeof text === 'string' ? text : JSON.stringify(text),
        usage: parsed?.usage || {},
        model: parsed?.modelUsage ? Object.keys(parsed.modelUsage)[0] : model,
        sessionId: parsed?.session_id ?? null,
        costUsd: parsed?.total_cost_usd ?? null,
        raw: parsed,
      });
    });
    child.stdin.end(prompt);
  });
}

/**
 * Serve an Anthropic /v1/messages request by escalating to Claude via the CLI,
 * and return a well-formed Anthropic message.
 */
export async function escalateViaCLI(body, {
  model = 'sonnet',
  shape = 'relay',
  cwd = process.cwd(),
  timeoutMs = 300_000,
  bin,
  env,
  lean = true,
} = {}) {
  const includeTools = shape === 'relay' && Array.isArray(body.tools) && body.tools.length > 0;
  const prompt = renderConversation(body, { includeTools });
  const appendSystemPrompt = includeTools ? TOOL_CONTRACT : null;

  const result = await runClaudeCLI({ prompt, model, appendSystemPrompt, cwd, timeoutMs, bin, env, lean });

  // Claude's <tool_call> blocks become real tool_use content for the caller.
  const scanned = scanText(result.text, { thinking: 'strip', textToolCalls: includeTools });
  const content = [];
  if (scanned.text.trim()) content.push({ type: 'text', text: scanned.text.trim() });
  for (const call of scanned.toolCalls) {
    content.push({ type: 'tool_use', id: newToolUseId(), name: call.name, input: call.input });
  }
  if (!content.length) content.push({ type: 'text', text: '' });

  const u = result.usage || {};
  return {
    message: {
      id: `msg_blaude_cli_${(result.sessionId || '').slice(0, 12) || Math.random().toString(16).slice(2, 14)}`,
      type: 'message',
      role: 'assistant',
      model: `claude-cli:${result.model || model}`,
      content,
      stop_reason: scanned.toolCalls.length ? 'tool_use' : 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: u.input_tokens ?? estimateTokens(prompt),
        output_tokens: u.output_tokens ?? estimateTokens(result.text),
        cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
      },
    },
    costUsd: result.costUsd,
    sessionId: result.sessionId,
  };
}
