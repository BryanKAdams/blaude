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
export function planContextChange(tokens, detected = detectOllama(), { kvType = null } = {}) {
  const value = String(Math.max(2048, Math.floor(tokens)));
  const steps = [];

  // launchctl setenv makes the value visible to GUI-launched processes, which is
  // how the menu-bar app gets it.
  steps.push({
    description: `set OLLAMA_CONTEXT_LENGTH=${value} for GUI-launched processes`,
    command: `launchctl setenv OLLAMA_CONTEXT_LENGTH ${value}`,
    argv: ['launchctl', ['setenv', 'OLLAMA_CONTEXT_LENGTH', value]],
  });

  // A quantised KV cache is what makes a very large context fit in unified
  // memory, and Ollama only honours it with flash attention enabled.
  if (kvType && kvType !== 'f16') {
    steps.push({
      description: 'enable flash attention (required for a quantised KV cache)',
      command: 'launchctl setenv OLLAMA_FLASH_ATTENTION 1',
      argv: ['launchctl', ['setenv', 'OLLAMA_FLASH_ATTENTION', '1']],
    });
    steps.push({
      description: `set the KV cache type to ${kvType}, which is what makes ${Number(value).toLocaleString()} tokens fit`,
      command: `launchctl setenv OLLAMA_KV_CACHE_TYPE ${kvType}`,
      argv: ['launchctl', ['setenv', 'OLLAMA_KV_CACHE_TYPE', kvType]],
    });
  }

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

// ---------------------------------------------------------------------------
// Can this machine actually hold that context?
// ---------------------------------------------------------------------------

/**
 * KV cache cost per token, from the model's own architecture.
 *
 * Two tensors (K and V) per layer, sized by the number of key/value heads times
 * the head dimension. This is what makes a big context expensive: it scales
 * linearly with context length AND with model depth, so a 65-layer model pays
 * far more per token than a 36-layer one.
 */
export async function modelMemoryProfile(baseUrl, model) {
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/show`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`could not inspect "${model}" (HTTP ${res.status})`);
  const body = await res.json();
  const info = body.model_info || {};
  const pick = (suffix) => {
    const key = Object.keys(info).find((k) => k.endsWith(suffix));
    return key ? info[key] : null;
  };

  const layers = pick('block_count');
  const kvHeads = pick('attention.head_count_kv');
  const heads = pick('attention.head_count');
  const embedding = pick('embedding_length');
  let headDim = pick('attention.key_length');
  if (!headDim && embedding && heads) headDim = Math.floor(embedding / heads);
  const modelMaxContext = pick('context_length');

  const bytesPerTokenFp16 = layers && kvHeads && headDim ? 2 * layers * kvHeads * headDim * 2 : null;
  return {
    model,
    layers,
    kvHeads,
    headDim,
    modelMaxContext,
    bytesPerTokenFp16,
    parameterSize: body.details?.parameter_size ?? null,
    quantization: body.details?.quantization_level ?? null,
    capabilities: body.capabilities || [],
  };
}

export const KV_TYPES = { f16: 1, q8_0: 2, q4_0: 4 };

/**
 * Memory actually available right now, not the size of the machine.
 *
 * Planning against total memory is how you end up swapping: this Mac has 52 GB
 * but was already using ~15 GB for editors, browsers and other Claude Code
 * sessions, so a "35 GB fits in 52 GB" plan pushed 11 GB into swap and the model
 * failed to stay resident. Free plus inactive pages is what a new allocation can
 * really draw on.
 */
export function availableMemory() {
  const out = spawnSync('vm_stat', [], { encoding: 'utf8' }).stdout || '';
  const pageSize = Number(/page size of (\d+)/.exec(out)?.[1] || 16384);
  const pages = (label) => Number(new RegExp(`${label}:\\s+(\\d+)`).exec(out)?.[1] || 0);
  const free = pages('Pages free') + pages('Pages inactive') + pages('Pages purgeable');
  const swap = spawnSync('sysctl', ['-n', 'vm.swapusage'], { encoding: 'utf8' }).stdout || '';
  const swapUsedMb = Number(/used = ([\d.]+)M/.exec(swap)?.[1] || 0);
  return {
    availableBytes: free * pageSize,
    swapUsedBytes: swapUsedMb * 1e6,
    alreadySwapping: swapUsedMb > 512,
  };
}

/**
 * Work out which KV cache type (if any) makes `tokens` of context fit.
 *
 * `weightsBytes` is taken from the installed model size, and a slice of memory
 * is held back for macOS and everything else you have open — a context that
 * technically fits but leaves nothing for the system will swap, which is far
 * slower than a smaller context.
 */
export function planMemory({ profile, tokens, weightsBytes, totalBytes, reserveBytes = 6e9, availableBytes = null }) {
  // Plan against what is free now (minus a cushion for the rest of the system),
  // falling back to total memory only when availability cannot be read.
  const headroom = availableBytes != null ? availableBytes : totalBytes;
  const budget = headroom - reserveBytes - weightsBytes;
  const options = Object.entries(KV_TYPES).map(([type, divisor]) => {
    const kvBytes = profile.bytesPerTokenFp16 ? (profile.bytesPerTokenFp16 * tokens) / divisor : null;
    return { type, kvBytes, totalBytes: kvBytes == null ? null : kvBytes + weightsBytes, fits: kvBytes != null && kvBytes <= budget };
  });
  return {
    budget,
    headroom,
    options,
    exceedsModelMax: Boolean(profile.modelMaxContext && tokens > profile.modelMaxContext),
    recommended: options.find((o) => o.fits) || null,
  };
}
