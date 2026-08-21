// Reads and changes the local Ollama daemon's context cap.
//
// Ollama defaults to a modest context to protect RAM, and it TRUNCATES rather
// than erroring when a prompt exceeds it. For a Claude Code workload (20k-40k
// token prompts) the default is far too small, so Blaude needs to both see the
// current value and be able to raise it.
//
// On macOS the daemon runs either as the menu-bar app or as a plain
// `ollama serve` process, and the setting is the OLLAMA_CONTEXT_LENGTH
// environment variable — so raising it means setting the variable and restarting
// the daemon. Nothing here touches the network.

import { spawnSync, spawn } from 'node:child_process';

export function detectOllama() {
  const ps = spawnSync('ps', ['-Ao', 'pid,command'], { encoding: 'utf8' }).stdout || '';
  const lines = ps.split('\n');
  const app = lines.find((l) => /Ollama\.app/.test(l) && !/grep/.test(l));
  const serve = lines.find((l) => /\bollama\b.*\bserve\b/.test(l) && !/grep/.test(l) && !/Ollama\.app/.test(l));
  const pidOf = (line) => (line ? Number(line.trim().split(/\s+/)[0]) : null);
  return {
    running: Boolean(app || serve),
    flavour: app ? 'app' : serve ? 'serve' : null,
    pid: pidOf(app || serve),
    launchctlValue: (spawnSync('launchctl', ['getenv', 'OLLAMA_CONTEXT_LENGTH'], { encoding: 'utf8' }).stdout || '').trim() || null,
    envValue: process.env.OLLAMA_CONTEXT_LENGTH || null,
  };
}

/** Context size Ollama reports for currently-loaded models, if any. */
export async function loadedContexts(baseUrl = 'http://127.0.0.1:11434') {
  try {
    const res = await fetch(`${baseUrl}/api/ps`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return [];
    const body = await res.json();
    return (body.models || []).map((m) => ({
      name: m.name || m.model,
      contextLength: m.context_length ?? m.context ?? null,
      sizeVram: m.size_vram ?? null,
      expiresAt: m.expires_at ?? null,
    }));
  } catch { return []; }
}

/**
 * Plan (and optionally perform) raising the cap.
 * @returns {{steps:Array<{描述?:string, description:string, command:string}>, flavour:string|null}}
 */
export function planContextChange(tokens, detected = detectOllama()) {
  const value = String(Math.max(2048, Math.floor(tokens)));
  const steps = [];

  // launchctl setenv makes the value visible to GUI-launched processes, which is
  // how the menu-bar app gets it.
  steps.push({
    description: `set OLLAMA_CONTEXT_LENGTH=${value} for GUI-launched processes`,
    command: `launchctl setenv OLLAMA_CONTEXT_LENGTH ${value}`,
    argv: ['launchctl', ['setenv', 'OLLAMA_CONTEXT_LENGTH', value]],
  });

  if (detected.flavour === 'app') {
    // `killall` rather than AppleScript: telling an app to quit via osascript
    // needs macOS Automation consent, which fails with -128 when not granted.
    // Ollama is a server with no unsaved state, so a plain terminate is fine.
    steps.push({
      description: 'restart the Ollama app so it picks up the new value',
      command: 'killall Ollama && sleep 2 && open -a Ollama',
      argv: ['killall', ['Ollama']],
      followUp: ['open', ['-a', 'Ollama']],
    });
  } else if (detected.flavour === 'serve') {
    steps.push({
      description: `stop the running \`ollama serve\` (pid ${detected.pid}) and start it with the new value`,
      command: `kill ${detected.pid} && OLLAMA_CONTEXT_LENGTH=${value} ollama serve`,
      argv: ['kill', [String(detected.pid)]],
      followUp: ['ollama', ['serve'], { OLLAMA_CONTEXT_LENGTH: value }],
    });
  } else {
    steps.push({
      description: 'start Ollama with the new value',
      command: `OLLAMA_CONTEXT_LENGTH=${value} ollama serve`,
      argv: ['ollama', ['serve'], { OLLAMA_CONTEXT_LENGTH: value }],
    });
  }

  return { steps, flavour: detected.flavour, value: Number(value) };
}

export function applyStep(step) {
  const [bin, args, extraEnv] = step.argv;
  if (bin === 'ollama' && args[0] === 'serve') {
    // Long-lived daemon: detach so it outlives this command.
    const child = spawn(bin, args, {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ...(extraEnv || {}) },
    });
    child.unref();
    return { ok: true, detached: true, pid: child.pid };
  }
  const r = spawnSync(bin, args, { encoding: 'utf8', env: { ...process.env, ...(extraEnv || {}) } });
  const result = { ok: r.status === 0, status: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
  if (result.ok && step.followUp) {
    // The app needs a moment to finish shutting down, or the relaunch is a no-op.
    spawnSync('sleep', ['3']);
    const [fbin, fargs, fenv] = step.followUp;
    const child = spawn(fbin, fargs, { detached: true, stdio: 'ignore', env: { ...process.env, ...(fenv || {}) } });
    child.unref();
    result.followUpPid = child.pid;
  }
  return result;
}

export async function waitForOllama(baseUrl = 'http://127.0.0.1:11434', timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/version`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch { /* keep waiting */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Ground truth for the context limit
// ---------------------------------------------------------------------------

const residentCache = { at: 0, value: [] };

/**
 * The context Ollama ACTUALLY allocated for a loaded model.
 *
 * This beats probing, because the number changes with memory pressure: Ollama
 * sizes context to fit, so one resident model on a 48 GB Mac got 40,960 while
 * two resident models got ~20k and ~16k each. /api/ps reports the real figure
 * for the current load, which is what Blaude should fit prompts to.
 */
export async function residentContext(baseUrl, model, { ttlMs = 10_000 } = {}) {
  if (Date.now() - residentCache.at > ttlMs) {
    residentCache.value = await loadedContexts(baseUrl);
    residentCache.at = Date.now();
  }
  const hit = residentCache.value.find((m) => m.name === model || m.name?.startsWith(model));
  return hit?.contextLength ?? null;
}
