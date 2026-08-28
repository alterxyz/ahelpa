#!/usr/bin/env bash
# Install ahelpa from GitHub Releases, then install the global hard-copy skill
# for Codex, Claude Code, and Kimi Code through the existing `skills` CLI.

set -euo pipefail

REPO="${AHELPA_REPO:-alterxyz/ahelpa}"
VERSION="${AHELPA_VERSION:-latest}"
BIN_DIR="${AHELPA_BIN_DIR:-$HOME/.ahelpa/bin}"

# Pick the release asset for this OS/arch. Supports macOS and Linux; the
# runtime itself is platform-agnostic Bun, so binaries are produced per
# platform by the release workflow.
OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS/$ARCH" in
  Darwin/arm64) PLATFORM="darwin-arm64" ;;
  Darwin/x86_64) PLATFORM="darwin-x64" ;;
  Linux/x86_64 | Linux/amd64) PLATFORM="linux-x64" ;;
  Linux/aarch64 | Linux/arm64) PLATFORM="linux-arm64" ;;
  *)
    echo "ahelpa has no prebuilt runtime for $OS/$ARCH." >&2
    echo "Build from source instead: clone the repo and run scripts/deploy-local.sh" >&2
    exit 1
    ;;
esac
ASSET_NAME="ahelpa-${PLATFORM}.tar.gz"

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

echo "== install global skills -> codex + claude-code + kimi-code-cli =="
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
