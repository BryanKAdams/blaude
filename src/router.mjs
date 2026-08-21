// Maps a requested model id onto a concrete (backend, upstream model) pair.
//
// Routing is intentionally boring and inspectable: explicit prefix wins, then an
// exact entry in `models`, then the first matching glob in `routes`, then the
// default. Nothing implicitly reaches a paid endpoint.

export function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp('^' + escaped.replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
}

export function globMatch(glob, value) {
  return globToRegExp(glob).test(value ?? '');
}

const PREFIXES = {
  'local/': null, // resolve remainder against `models`, never cloud
  'blaude/': null,
  'cloud/': 'anthropic',
  'anthropic/': 'anthropic',
};

export class RouteError extends Error {
  constructor(message, { status = 400, type = 'invalid_request_error' } = {}) {
    super(message);
    this.status = status;
    this.type = type;
  }
}

/**
 * @returns {{requested:string, target:string, backendName:string, backend:object,
 *            model:string, maxContext?:number, maxOutput?:number, via:string,
 *            passthrough:boolean}}
 */
export function resolveModel(cfg, requested) {
  const asked = String(requested ?? '').trim();
  if (!asked) throw new RouteError('Request is missing the "model" field');

  // 1. Explicit prefix.
  for (const [prefix, forcedBackend] of Object.entries(PREFIXES)) {
    if (!asked.toLowerCase().startsWith(prefix)) continue;
    const rest = asked.slice(prefix.length);
    if (forcedBackend) return cloudTarget(cfg, rest || 'claude-opus-4-5', `prefix:${prefix}`);
    return localTarget(cfg, rest, `prefix:${prefix}`, asked);
  }

  // 2. A logical model defined in config.
  if (cfg.models[asked]) return materialize(cfg, asked, cfg.models[asked], 'models', asked);

  // 3. Routes, first match wins.
  for (const route of cfg.routes) {
    if (!globMatch(route.match, asked)) continue;
    if (route.backend && cfg.backends[route.backend]?.kind === 'anthropic') {
      return cloudTarget(cfg, route.model || asked, `route:${route.match}`, route.backend);
    }
    const targetName = route.model || cfg.defaultModel;
    const entry = cfg.models[targetName];
    if (!entry) throw new RouteError(`Route "${route.match}" targets unknown model "${targetName}"`);
    return materialize(cfg, targetName, entry, `route:${route.match}`, asked);
  }

  // 4. Default.
  return materialize(cfg, cfg.defaultModel, cfg.models[cfg.defaultModel], 'default', asked);
}

function localTarget(cfg, name, via, requested) {
  const entry = cfg.models[name];
  if (!entry) {
    const known = Object.keys(cfg.models).join(', ');
    throw new RouteError(`Unknown local model "${name}". Configured local models: ${known}`);
  }
  return materialize(cfg, name, entry, via, requested);
}

function materialize(cfg, targetName, entry, via, requested) {
  const backend = cfg.backends[entry.backend];
  if (!backend) throw new RouteError(`Model "${targetName}" references unknown backend "${entry.backend}"`);
  return {
    requested: requested ?? targetName,
    target: targetName,
    backendName: entry.backend,
    backend,
    model: entry.model,
    maxContext: entry.maxContext,
    maxOutput: entry.maxOutput,
    temperature: entry.temperature,
    via,
    passthrough: backend.kind === 'anthropic',
  };
}

function cloudTarget(cfg, model, via, backendName = 'anthropic') {
  const backend = cfg.backends[backendName];
  if (!backend) throw new RouteError(`No "${backendName}" backend configured`);
  const key = backend.apiKey || process.env[backend.apiKeyEnv || 'ANTHROPIC_API_KEY'];
  if (!key) {
    throw new RouteError(
      `Cloud escalation to "${model}" needs ${backend.apiKeyEnv || 'ANTHROPIC_API_KEY'} to be set. ` +
      `If you are on a Claude subscription rather than API billing, escalate with a stock Claude Code ` +
      `session instead (\`blaude escalate\`) — that path uses your subscription, not an API key.`,
      { status: 401, type: 'authentication_error' },
    );
  }
  return {
    requested: model,
    target: `cloud:${model}`,
    backendName,
    backend: { ...backend, apiKey: key },
    model,
    via,
    passthrough: true,
  };
}
