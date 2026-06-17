#!/usr/bin/env bash
# Install ahelpa from GitHub Releases, then install the global hard-copy skill
# for Codex and Claude Code through the existing `skills` CLI.

set -euo pipefail

REPO="${AHELPA_REPO:-alterxyz/ahelpa}"
VERSION="${AHELPA_VERSION:-latest}"
BIN_DIR="${AHELPA_BIN_DIR:-$HOME/.ahelpa/bin}"
ASSET_NAME="ahelpa-darwin-arm64.tar.gz"

OS="$(uname -s)"
ARCH="$(uname -m)"
if [ "$OS" != "Darwin" ] || [ "$ARCH" != "arm64" ]; then
  echo "ahelpa currently ships a macOS arm64 runtime only (got $OS $ARCH)." >&2
  exit 1
fi

if [ -n "${AHELPA_ARCHIVE_URL:-}" ]; then
  ARCHIVE_URL="$AHELPA_ARCHIVE_URL"
else
  if [ "$VERSION" = "latest" ]; then
    ARCHIVE_URL="https://github.com/$REPO/releases/latest/download/$ASSET_NAME"
  else
    ARCHIVE_URL="https://github.com/$REPO/releases/download/$VERSION/$ASSET_NAME"
  fi
fi

TMPDIR_INSTALL="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_INSTALL"' EXIT

echo "== download runtime =="
echo "$ARCHIVE_URL"
curl -fsSL "$ARCHIVE_URL" -o "$TMPDIR_INSTALL/$ASSET_NAME"

echo "== install runtime -> $BIN_DIR =="
mkdir -p "$BIN_DIR"
tar xzf "$TMPDIR_INSTALL/$ASSET_NAME" -C "$BIN_DIR"
chmod 755 "$BIN_DIR/ahelpa"

if [ "$VERSION" = "latest" ]; then
  SKILL_SOURCE="$REPO"
else
  SKILL_SOURCE="https://github.com/$REPO/tree/$VERSION/skill"
fi

echo "== install global skills -> codex + claude-code =="
"$BIN_DIR/ahelpa" install-skill --source "$SKILL_SOURCE"

echo "== installed =="
"$BIN_DIR/ahelpa" version

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    echo
    echo "Add ahelpa to PATH if your shell cannot find it:"
    echo "  export PATH=\"\$HOME/.ahelpa/bin:\$PATH\""
    ;;
esac
