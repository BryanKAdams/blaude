#!/usr/bin/env bash
#
# Install Blaude from its latest GitHub release.
#
#   curl -fsSL https://raw.githubusercontent.com/BryanKAdams/blaude/main/install.sh | bash
#   gh release download --repo BryanKAdams/blaude --pattern install.sh -O - | bash   # private repo
#
# Everything lands under ~/.blaude/versions/<version>, with ~/.blaude/current
# pointing at the live one. That layout is what makes `blaude update` a symlink
# swap and `blaude update --rollback` instant.
#
# Env: BLAUDE_REPO, BLAUDE_HOME, BLAUDE_BIN_DIR, BLAUDE_VERSION (a tag to pin)
set -euo pipefail

REPO="${BLAUDE_REPO:-BryanKAdams/blaude}"
HOME_DIR="${BLAUDE_HOME:-$HOME/.blaude}"
BIN_DIR="${BLAUDE_BIN_DIR:-$HOME/.local/bin}"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
dim()  { printf '\033[90m%s\033[0m\n' "$1"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$1"; }
die()  { printf '\033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "node is required (>= 20). Install it, then re-run: https://nodejs.org"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "node >= 20 is required (found $(node -v)). Blaude uses built-in fetch and node:test."
command -v tar >/dev/null 2>&1 || die "tar is required"

# Both fetch paths, so this works whether or not the repo is public. An
# anonymous 404 means "private, or no releases" — gh is what tells them apart.
have_gh() { command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; }

resolve_tag() {
  if [ -n "${BLAUDE_VERSION:-}" ]; then printf '%s' "$BLAUDE_VERSION"; return; fi
  local body
  if body="$(curl -fsSL -H 'Accept: application/vnd.github+json' \
      "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null)"; then
    printf '%s' "$body" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1
    return
  fi
  have_gh || die "cannot read releases for $REPO anonymously, and gh is unavailable.
  The repository is private — install gh (brew install gh) and run: gh auth login"
  gh release view --repo "$REPO" --json tagName -q .tagName
}

fetch_asset() {  # tag name dest
  local tag="$1" name="$2" dest="$3"
  if curl -fsSL "https://github.com/$REPO/releases/download/$tag/$name" -o "$dest" 2>/dev/null; then return 0; fi
  have_gh || die "cannot download $name (and gh is unavailable)"
  gh release download "$tag" --repo "$REPO" --pattern "$name" --dir "$(dirname "$dest")" --clobber
}

TAG="$(resolve_tag)"
[ -n "$TAG" ] || die "$REPO has no published releases yet"
VERSION="${TAG#v}"
bold "Installing blaude $VERSION"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
ASSET="blaude-$VERSION.tar.gz"

dim "  downloading $ASSET"
fetch_asset "$TAG" "$ASSET" "$TMP/$ASSET"

# Verify when the release publishes a checksum. This script is piped into a
# shell from the network; a truncated tarball should fail loudly, not install.
if fetch_asset "$TAG" "$ASSET.sha256" "$TMP/$ASSET.sha256" 2>/dev/null; then
  EXPECTED="$(awk '{print $1}' "$TMP/$ASSET.sha256")"
  if command -v shasum >/dev/null 2>&1; then ACTUAL="$(shasum -a 256 "$TMP/$ASSET" | awk '{print $1}')"
  else ACTUAL="$(sha256sum "$TMP/$ASSET" | awk '{print $1}')"; fi
  [ "$EXPECTED" = "$ACTUAL" ] || die "checksum mismatch for $ASSET
  expected $EXPECTED
  got      $ACTUAL"
  dim "  checksum ok"
else
  dim "  (no checksum published for this release — skipping verification)"
fi

TARGET="$HOME_DIR/versions/$VERSION"
mkdir -p "$HOME_DIR/versions" "$BIN_DIR"
rm -rf "$TARGET.staging"
mkdir -p "$TARGET.staging"
tar -xzf "$TMP/$ASSET" -C "$TARGET.staging" --strip-components=1
[ -f "$TARGET.staging/bin/blaude.mjs" ] || die "that tarball has no bin/blaude.mjs — it is not a Blaude release"
rm -rf "$TARGET"
mv "$TARGET.staging" "$TARGET"
chmod +x "$TARGET/bin/blaude.mjs"

# rename(2) over an existing symlink is atomic, so a session starting mid-install
# sees either the old release or the new one, never a dangling link.
ln -sfn "$TARGET" "$HOME_DIR/current.new-$$"
mv -f "$HOME_DIR/current.new-$$" "$HOME_DIR/current"
ln -sfn "$HOME_DIR/current/bin/blaude.mjs" "$BIN_DIR/blaude"

ok "blaude $VERSION → $BIN_DIR/blaude"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) printf '\n\033[33m!\033[0m %s is not on your PATH. Add it:\n    export PATH="%s:$PATH"\n' "$BIN_DIR" "$BIN_DIR" ;;
esac

cat <<'NEXT'

  Next:
    blaude use        pick a local model (lists what Ollama has)
    blaude doctor     check backends, tool support, context cap, allowance
    blaude route auto Claude does the work while you have allowance
    blaude guard on   stop native Claude sessions at your floor
    blaude            start a session

  Later:  blaude update

NEXT
