// @ts-nocheck — not yet typed. `npm test` runs `tsc --checkJs` over this repo;
// the translation layer (anthropic-to-openai, openai-to-anthropic, stream,
// text-scanner, fit-context) is clean and stays clean. This file is not, so it
// opts out rather than making the check unrunnable. Delete this line, run
// `npm run typecheck`, and fix what it says.
// In-place updates from GitHub Releases.
//
// Two things shape this file.
//
// The repository is private today and may be public later, so every network
// read tries the anonymous path first and falls back to the `gh` CLI when
// GitHub answers 404/403. A 404 from the REST API is genuinely ambiguous — it
// is what you get for "no such repo", "no releases yet", and "private, and you
// are anonymous" alike — so the fallback is what turns that into a real answer.
// Flipping the repo public changes nothing here; the anonymous path simply
// starts succeeding.
//
// And this is the code that decides how much of your Claude subscription gets
// spent, so it never installs anything on its own. `blaude update` asks, the
// startup notice only mentions, and a git checkout is never touched.

import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, renameSync,
  symlinkSync, lstatSync, readlinkSync, readdirSync, createWriteStream,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { BLAUDE_HOME } from './config.mjs';
import { VERSION, ROOT, compareVersions } from './version.mjs';

export const DEFAULT_REPO = 'BryanKAdams/blaude';
const CACHE_FILE = () => join(BLAUDE_HOME, 'update-cache.json');
const STATE_FILE = () => join(BLAUDE_HOME, 'update-state.json');
const VERSIONS_DIR = () => join(BLAUDE_HOME, 'versions');
const CURRENT_LINK = () => join(BLAUDE_HOME, 'current');

/** How many unpacked releases to keep, so a rollback always has somewhere to go. */
const KEEP_VERSIONS = 3;

export function updateRepo(cfg = null) {
  return process.env.BLAUDE_UPDATE_REPO || cfg?.updates?.repo || DEFAULT_REPO;
}

// ---------------------------------------------------------------------------
// Where is this copy of Blaude installed?
// ---------------------------------------------------------------------------

/**
 * Classify the running install, because the safe action differs completely.
 *
 *   release — unpacked under ~/.blaude/versions; swapping it is just a rename
 *   git     — a working checkout, possibly with your own uncommitted edits;
 *             overwriting it would destroy work, so we only ever say "git pull"
 *   other   — copied or npm-linked somewhere we do not manage
 */
export function describeInstall(root = ROOT) {
  const versions = VERSIONS_DIR();
  if (root === versions || root.startsWith(`${versions}/`)) {
    return { kind: 'release', root, writable: true };
  }
  let dir = root;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, '.git'))) return { kind: 'git', root, repoRoot: dir, writable: false };
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return { kind: 'other', root, writable: false };
}

// ---------------------------------------------------------------------------
// Reading the latest release
// ---------------------------------------------------------------------------

function ghAvailable() {
  const probe = spawnSync('gh', ['auth', 'status'], { stdio: 'ignore', timeout: 10_000 });
  return probe.status === 0;
}

function ghJSON(args, timeoutMs) {
  const res = spawnSync('gh', args, { encoding: 'utf8', timeout: timeoutMs });
  if (res.error) throw new Error(`cannot run "gh": ${res.error.message}`);
  if (res.status !== 0) throw new Error(String(res.stderr || '').trim() || `gh exited ${res.status}`);
  return JSON.parse(res.stdout);
}

function normalizeRelease(raw) {
  return {
    tag: raw.tag_name ?? raw.tagName ?? null,
    version: String(raw.tag_name ?? raw.tagName ?? '').replace(/^v/, ''),
    name: raw.name ?? null,
    notes: raw.body ?? raw.notes ?? '',
    publishedAt: raw.published_at ?? raw.publishedAt ?? null,
    assets: (raw.assets ?? []).map((a) => ({ name: a.name, size: a.size ?? null })),
  };
}

/**
 * The newest published release, or null when there are none yet.
 *
 * @param {{repo?:string, timeoutMs?:number, allowGh?:boolean}} opts
 * @returns {Promise<{release:object|null, via:'public'|'gh'}>}
 */
export async function fetchLatestRelease({ repo = DEFAULT_REPO, timeoutMs = 15_000, allowGh = true } = {}) {
  let publicError = null;
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': `blaude/${VERSION}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) return { release: normalizeRelease(await res.json()), via: 'public' };
    // 404 here is ambiguous — private repo, or no releases. `gh` can tell them apart.
    if (res.status !== 404 && res.status !== 403 && res.status !== 401) {
      publicError = new Error(`GitHub answered ${res.status}`);
    }
  } catch (e) {
    publicError = e;
  }

  if (!allowGh) {
    if (publicError) throw publicError;
    return { release: null, via: 'public' };
  }
  if (!ghAvailable()) {
    throw new Error(
      `cannot read releases for ${repo} anonymously, and the GitHub CLI is not available.\n` +
      `  The repository is private: install gh (brew install gh) and run "gh auth login".`,
    );
  }
  try {
    const raw = ghJSON(
      ['release', 'view', '--repo', repo, '--json', 'tagName,name,body,publishedAt,assets'],
      timeoutMs,
    );
    return { release: normalizeRelease(raw), via: 'gh' };
  } catch (e) {
    if (/release not found|no releases/i.test(e.message)) return { release: null, via: 'gh' };
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Cached checks, so the startup notice never blocks a session
// ---------------------------------------------------------------------------

function readCache() {
  try {
    return JSON.parse(readFileSync(CACHE_FILE(), 'utf8'));
  } catch {
    return null;
  }
}

export function writeUpdateCache(entry) {
  try {
    if (!existsSync(BLAUDE_HOME)) mkdirSync(BLAUDE_HOME, { recursive: true });
    writeFileSync(CACHE_FILE(), JSON.stringify({ ...entry, cachedAt: Date.now() }, null, 2));
  } catch { /* the cache is an optimisation */ }
}

/** Fire-and-forget refresh, so the next launch has a warm answer. */
function refreshDetached() {
  try {
    const child = spawn(process.execPath, [join(ROOT, 'bin', 'blaude.mjs'), 'update', '--refresh-cache'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch { /* best effort */ }
}

/**
 * Is there a newer release?
 *
 * Serves a fresh cache directly; serves a stale one and refreshes behind your
 * back; only a cold cache waits on the network, and callers that cannot afford
 * even that pass `block: false` and get null.
 *
 * @returns {Promise<{current:string, latest:string|null, tag:string|null, newer:boolean, checkedAt:number, stale:boolean}|null>}
 */
export async function checkForUpdate({
  repo = DEFAULT_REPO, ttlMs = 6 * 60 * 60 * 1000, block = true, timeoutMs = 15_000,
} = {}) {
  const cached = readCache();
  const fresh = cached && cached.repo === repo && Date.now() - (cached.cachedAt || 0) < ttlMs;
  if (fresh) return { ...summarize(cached), stale: false };

  if (!block) {
    refreshDetached();
    return cached && cached.repo === repo ? { ...summarize(cached), stale: true } : null;
  }

  const { release } = await fetchLatestRelease({ repo, timeoutMs });
  const entry = { repo, latest: release?.version ?? null, tag: release?.tag ?? null, notes: release?.notes ?? '' };
  writeUpdateCache(entry);
  return { ...summarize(entry), stale: false, notes: release?.notes ?? '' };
}

function summarize(entry) {
  return {
    current: VERSION,
    latest: entry.latest ?? null,
    tag: entry.tag ?? null,
    newer: Boolean(entry.latest) && compareVersions(entry.latest, VERSION) > 0,
    checkedAt: entry.cachedAt ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Downloading and verifying
// ---------------------------------------------------------------------------

export const assetName = (version) => `blaude-${version}.tar.gz`;

async function downloadPublic(repo, tag, name, dest, timeoutMs) {
  const res = await fetch(`https://github.com/${repo}/releases/download/${tag}/${name}`, {
    headers: { 'user-agent': `blaude/${VERSION}` },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${name}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

function downloadViaGh(repo, tag, name, dir, timeoutMs) {
  const res = spawnSync(
    'gh',
    ['release', 'download', tag, '--repo', repo, '--pattern', name, '--dir', dir, '--clobber'],
    { encoding: 'utf8', timeout: timeoutMs },
  );
  if (res.error) throw new Error(`cannot run "gh": ${res.error.message}`);
  if (res.status !== 0) throw new Error(String(res.stderr || '').trim() || `gh exited ${res.status}`);
}

/** Public first, `gh` second — the same ladder as reading the release. */
async function fetchAsset({ repo, tag, name, dir, timeoutMs }) {
  const dest = join(dir, name);
  try {
    await downloadPublic(repo, tag, name, dest, timeoutMs);
    return dest;
  } catch (publicError) {
    if (!ghAvailable()) {
      throw new Error(`could not download ${name}: ${publicError.message} (and the GitHub CLI is unavailable)`);
    }
    downloadViaGh(repo, tag, name, dir, timeoutMs);
    if (!existsSync(dest)) throw new Error(`gh reported success but ${name} is not in ${dir}`);
    return dest;
  }
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

// ---------------------------------------------------------------------------
// Installing
// ---------------------------------------------------------------------------

function untar(tarball, into) {
  mkdirSync(into, { recursive: true });
  const res = spawnSync('tar', ['-xzf', tarball, '-C', into, '--strip-components=1'], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (res.error) throw new Error(`cannot run "tar": ${res.error.message}`);
  if (res.status !== 0) throw new Error(`tar failed: ${String(res.stderr || '').trim()}`);
}

/** Point ~/.blaude/current at a version directory without ever being unlinked. */
function repoint(target) {
  const link = CURRENT_LINK();
  const staging = `${link}.new-${process.pid}`;
  rmSync(staging, { force: true });
  symlinkSync(target, staging);
  // rename(2) over an existing symlink is atomic, so a session starting during
  // an update sees either the old release or the new one, never a missing link.
  renameSync(staging, link);
}

/** Keep the newest few unpacked releases; a rollback needs somewhere to land. */
function prune(keep) {
  let dirs;
  try {
    dirs = readdirSync(VERSIONS_DIR());
  } catch {
    return;
  }
  const versions = dirs
    .filter((d) => /^\d+\.\d+\.\d+/.test(d) && !keep.includes(d))
    .sort(compareVersions)
    .reverse();
  for (const old of versions.slice(Math.max(0, KEEP_VERSIONS - keep.length))) {
    rmSync(join(VERSIONS_DIR(), old), { recursive: true, force: true });
  }
}

/**
 * Download, verify and install a release, then repoint `current` at it.
 *
 * Nothing is swapped until the new tree is unpacked and its package.json says
 * the version the tag promised, so a truncated download or a mislabelled
 * release leaves the working install exactly where it was.
 */
export async function applyUpdate({
  repo = DEFAULT_REPO, release, verify = true, timeoutMs = 120_000, onStep = () => {},
} = {}) {
  if (!release?.tag) throw new Error('no release to install');
  const version = release.version;
  const tmp = join(BLAUDE_HOME, 'tmp', `update-${process.pid}`);
  mkdirSync(tmp, { recursive: true });

  try {
    const name = assetName(version);
    if (release.assets?.length && !release.assets.some((a) => a.name === name)) {
      throw new Error(
        `release ${release.tag} has no ${name}. Assets: ${release.assets.map((a) => a.name).join(', ') || '(none)'}`,
      );
    }
    onStep(`downloading ${name}`);
    const tarball = await fetchAsset({ repo, tag: release.tag, name, dir: tmp, timeoutMs });

    if (verify) {
      onStep('verifying checksum');
      let expected;
      try {
        const sumFile = await fetchAsset({ repo, tag: release.tag, name: `${name}.sha256`, dir: tmp, timeoutMs });
        expected = readFileSync(sumFile, 'utf8').trim().split(/\s+/)[0];
      } catch (e) {
        throw new Error(
          `release ${release.tag} publishes no ${name}.sha256, so the download cannot be verified ` +
          `(${e.message}).\n  Re-run with --no-verify if you trust this release anyway.`,
        );
      }
      const actual = sha256(tarball);
      if (actual !== expected) {
        throw new Error(`checksum mismatch for ${name}\n  expected ${expected}\n  got      ${actual}`);
      }
    }

    onStep('unpacking');
    const staging = join(VERSIONS_DIR(), `.staging-${version}-${process.pid}`);
    rmSync(staging, { recursive: true, force: true });
    untar(tarball, staging);

    if (!existsSync(join(staging, 'bin', 'blaude.mjs'))) {
      throw new Error(`the ${release.tag} tarball has no bin/blaude.mjs — it is not a Blaude release`);
    }
    const packed = JSON.parse(readFileSync(join(staging, 'package.json'), 'utf8')).version;
    if (packed !== version) {
      throw new Error(`tag ${release.tag} contains version ${packed} — refusing to install a mislabelled release`);
    }

    const finalDir = join(VERSIONS_DIR(), version);
    rmSync(finalDir, { recursive: true, force: true });
    renameSync(staging, finalDir);

    const previous = currentTarget();
    onStep('switching over');
    repoint(finalDir);
    writeFileSync(STATE_FILE(), JSON.stringify({
      version, previousVersion: previous ? previous.split('/').pop() : null,
      installedAt: Date.now(), repo, tag: release.tag,
    }, null, 2));
    prune([version, previous ? previous.split('/').pop() : ''].filter(Boolean));

    return { version, dir: finalDir, previousVersion: previous ? previous.split('/').pop() : null };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function currentTarget() {
  try {
    return lstatSync(CURRENT_LINK()).isSymbolicLink() ? readlinkSync(CURRENT_LINK()) : null;
  } catch {
    return null;
  }
}

/** Installed releases, newest first. */
export function installedVersions() {
  try {
    return readdirSync(VERSIONS_DIR())
      .filter((d) => /^\d+\.\d+\.\d+/.test(d))
      .sort(compareVersions)
      .reverse();
  } catch {
    return [];
  }
}

/** Swap `current` back to the version that was running before the last update. */
export function rollback(to = null) {
  let target = to;
  if (!target) {
    try {
      target = JSON.parse(readFileSync(STATE_FILE(), 'utf8')).previousVersion;
    } catch { /* fall through to the error below */ }
  }
  if (!target) throw new Error('no previous version recorded — pass one of: ' + (installedVersions().join(', ') || '(none installed)'));
  const dir = join(VERSIONS_DIR(), target);
  if (!existsSync(dir)) throw new Error(`version ${target} is not installed (have: ${installedVersions().join(', ') || 'none'})`);
  const from = currentTarget();
  repoint(dir);
  writeFileSync(STATE_FILE(), JSON.stringify({
    version: target, previousVersion: from ? from.split('/').pop() : null, installedAt: Date.now(), rolledBack: true,
  }, null, 2));
  return { version: target, from: from ? from.split('/').pop() : null };
}
