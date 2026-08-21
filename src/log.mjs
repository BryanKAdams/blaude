const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

export function makeLogger(level = 'info') {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const at = (lvl, prefix) => (...args) => {
    if ((LEVELS[lvl] ?? 3) <= threshold) console.error(prefix, ...args);
  };
  return {
    level,
    error: at('error', '\x1b[31m✗\x1b[0m'),
    warn: at('warn', '\x1b[33m!\x1b[0m'),
    info: at('info', '\x1b[36m·\x1b[0m'),
    debug: at('debug', '\x1b[90m›\x1b[0m'),
    plain: (...args) => console.error(...args),
  };
}
