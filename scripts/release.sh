#!/usr/bin/env bash
#
# Cut a Blaude release: test, pack, tag, publish.
#
#   scripts/release.sh              # release the version in package.json
#   scripts/release.sh 0.3.0        # bump package.json first, then release
#   scripts/release.sh --dry-run    # build the tarball, publish nothing
#
# The tarball is the unit `blaude update` installs, so it is built from an
# explicit file list rather than the working tree: no tests, no benchmarks, and
# nothing untracked that happened to be sitting in the directory.
set -euo pipefail
cd "$(dirname "$0")/.."

REPO="${BLAUDE_REPO:-BryanKAdams/blaude}"
DRY_RUN=0
BUMP=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -*) echo "unknown flag: $arg" >&2; exit 1 ;;
    *) BUMP="$arg" ;;
  esac
done

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$1"; }
die()  { printf '\033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }

command -v gh >/dev/null 2>&1 || die "the GitHub CLI is required: brew install gh"
gh auth status >/dev/null 2>&1 || die "run: gh auth login"

if [ -n "$BUMP" ]; then
  [[ "$BUMP" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || die "\"$BUMP\" is not a semver version"
  node -e '
    const fs = require("fs");
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
    pkg.version = process.argv[1];
    fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
  ' "$BUMP"
  ok "package.json → $BUMP"
fi

VERSION="$(node -p 'require("./package.json").version')"
TAG="v$VERSION"
bold "Releasing blaude $VERSION"

if [ -n "$(git status --porcelain)" ] && [ "$DRY_RUN" -eq 0 ]; then
  die "working tree is dirty. Commit first — the tag has to point at what you shipped."
fi
if [ "$DRY_RUN" -eq 0 ] && git rev-parse "$TAG" >/dev/null 2>&1; then
  die "$TAG already exists. Bump the version: scripts/release.sh <next>"
fi

# Never publish a release that cannot pass its own suite: this code routes
# subscription spend, and `blaude update` installs it without further review.
bold "Running tests"
npm test >/dev/null || die "tests failed — not releasing"
ok "tests pass"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
PKGDIR="$STAGE/blaude-$VERSION"
mkdir -p "$PKGDIR"
for item in bin src blaude.config.example.json README.md package.json LICENSE install.sh; do
  [ -e "$item" ] && cp -R "$item" "$PKGDIR/"
done
mkdir -p "$PKGDIR/scripts"
cp scripts/setup-mlx.sh "$PKGDIR/scripts/" 2>/dev/null || true
chmod +x "$PKGDIR/bin/blaude.mjs"

mkdir -p dist
ASSET="dist/blaude-$VERSION.tar.gz"
rm -f "$ASSET" "$ASSET.sha256"
tar -czf "$ASSET" -C "$STAGE" "blaude-$VERSION"

if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$ASSET" | awk '{print $1"  blaude-'"$VERSION"'.tar.gz"}' > "$ASSET.sha256"
else sha256sum "$ASSET" | awk '{print $1"  blaude-'"$VERSION"'.tar.gz"}' > "$ASSET.sha256"; fi
ok "$ASSET ($(du -h "$ASSET" | cut -f1))"

# Install the tarball into a throwaway home and run the CLI out of it. A release
# that unpacks but cannot start is exactly the failure this catches.
VERIFY="$STAGE/verify"
mkdir -p "$VERIFY"
tar -xzf "$ASSET" -C "$VERIFY" --strip-components=1
[ "$(node "$VERIFY/bin/blaude.mjs" --version)" = "blaude $VERSION" ] || die "the packed tarball does not report $VERSION"
ok "tarball runs and reports $VERSION"

if [ "$DRY_RUN" -eq 1 ]; then
  ok "dry run — nothing published"
  exit 0
fi

NOTES_FILE="$STAGE/notes.md"
PREV_TAG="$(git tag --sort=-v:refname | head -1)"
{
  if [ -n "$PREV_TAG" ]; then
    echo "## Changes since $PREV_TAG"
    echo
    git log --no-merges --pretty='- %s' "$PREV_TAG..HEAD"
  else
    echo "First release."
  fi
  echo
  echo '## Install'
  echo
  echo '```bash'
  echo "gh release download $TAG --repo $REPO --pattern install.sh -O - | bash"
  echo '```'
  echo
  echo 'Already installed? `blaude update`'
} > "$NOTES_FILE"

git tag -a "$TAG" -m "blaude $VERSION"
git push origin "$TAG"
gh release create "$TAG" \
  --repo "$REPO" \
  --title "blaude $VERSION" \
  --notes-file "$NOTES_FILE" \
  "$ASSET" "$ASSET.sha256" install.sh

ok "published $TAG"
gh release view "$TAG" --repo "$REPO" --json url -q .url
