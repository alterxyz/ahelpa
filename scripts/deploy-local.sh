#!/usr/bin/env bash
# Build the runtime, refresh the skill bundle, and install both on this
# machine: the runtime binary into ~/.ahelpa/bin and hard-copy global skills
# for Codex, Claude Code, and Kimi Code. Safe to re-run; a running daemon keeps its old
# inode and picks up the new binary on next start.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

BIN_DST="$HOME/.ahelpa/bin"

echo "== build runtime + skill bundle =="
bun run package:skill

echo "== install runtime -> $BIN_DST =="
mkdir -p "$BIN_DST"
install -m 755 dist/ahelpa "$BIN_DST/ahelpa"
if [ -d "$HOME/.local/bin" ]; then
  ln -sf "$BIN_DST/ahelpa" "$HOME/.local/bin/ahelpa"
fi

echo "== install global skills -> codex + claude-code + kimi-code-cli =="
"$BIN_DST/ahelpa" install-skill --source "$PROJECT_ROOT/skill"

echo "== deployed =="
"$BIN_DST/ahelpa" version
