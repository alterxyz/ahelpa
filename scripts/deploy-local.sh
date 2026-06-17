#!/usr/bin/env bash
# Build the runtime, refresh the skill bundle, and install both on this
# machine: the runtime binary into ~/.ahelpa/bin and the skill into
# ~/.claude/skills/ahelpa. Safe to re-run; a running daemon keeps its old
# inode and picks up the new binary on next start.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

SKILL_DST="$HOME/.claude/skills/ahelpa"
BIN_DST="$HOME/.ahelpa/bin"

echo "== build runtime + skill bundle =="
bun run package:skill

echo "== install runtime -> $BIN_DST =="
mkdir -p "$BIN_DST"
install -m 755 dist/ahelpa "$BIN_DST/ahelpa"
if [ -d "$HOME/.local/bin" ]; then
  ln -sf "$BIN_DST/ahelpa" "$HOME/.local/bin/ahelpa"
fi

echo "== install skill -> $SKILL_DST =="
mkdir -p "$SKILL_DST"
rsync -a --delete skill/ "$SKILL_DST/"

echo "== deployed =="
"$BIN_DST/ahelpa" version
