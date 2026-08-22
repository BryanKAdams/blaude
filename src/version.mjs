// The one place the version number lives.
//
// It used to be spelled out in three files, and they had already drifted. That
// is survivable for a banner, but not for `blaude update`, which decides whether
// to install a release by comparing this string to a git tag: a stale constant
// means the updater either re-installs what you already have or refuses an
// upgrade you need. So it is read from package.json — the same file the release
// tarball is built from — and there is nothing to keep in sync.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function read() {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const VERSION = read();

/**
 * Compare two semver-ish strings.
 *
 * Only the numeric core is compared, and a prerelease suffix (`-rc.1`) sorts
 * below the same core without it, per semver. Anything unparseable sorts low
 * rather than throwing: a malformed tag on the release should not be able to
 * crash the update check that a session prints on startup.
 *
 * @returns {number} negative if a < b, 0 if equal, positive if a > b
 */
export function compareVersions(a, b) {
  const parse = (v) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v || '').trim());
    if (!m) return null;
    return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] || null };
  };
  const x = parse(a);
  const y = parse(b);
  if (!x && !y) return 0;
  if (!x) return -1;
  if (!y) return 1;
  for (let i = 0; i < 3; i++) {
    if (x.nums[i] !== y.nums[i]) return x.nums[i] - y.nums[i];
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}
