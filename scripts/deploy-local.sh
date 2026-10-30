#!/usr/bin/env bash
# Build the runtime, refresh the skill bundle, and install both on this
# machine: the runtime binary into ~/.ahelpa/bin and hard-copy global skills
# for Codex, Claude Code, and Kimi Code. Safe to re-run; a running daemon is
# restarted on the new binary.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

BIN_DST="$HOME/.ahelpa/bin"

echo "== build runtime + skill bundle =="
bun run package:skill

echo "== install runtime -> $BIN_DST =="
mkdir -p "$BIN_DST"
if [ -x "$BIN_DST/ahelpa" ]; then
  # Keep the binary being replaced as ahelpa.pre-<incoming commit>, and only the
  # two newest of those; older runtimes are on GitHub Releases.
  cp -p "$BIN_DST/ahelpa" "$BIN_DST/ahelpa.pre-$(git -C "$PROJECT_ROOT" rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S)"
  ls -t "$BIN_DST"/ahelpa.pre-* | tail -n +3 | xargs rm -f --
fi
install -m 755 dist/ahelpa "$BIN_DST/ahelpa"
# The old daemon keeps running the replaced binary and cannot monitor sessions
# of drivers it does not know. Helpers keep running; only monitoring restarts.
if "$BIN_DST/ahelpa" status 2>/dev/null | grep -q '^ahelpa daemon: running'; then
  "$BIN_DST/ahelpa" daemon stop >/dev/null
  "$BIN_DST/ahelpa" daemon start >/dev/null
fi
if [ -d "$HOME/.local/bin" ]; then
  ln -sf "$BIN_DST/ahelpa" "$HOME/.local/bin/ahelpa"
fi

echo "== install global skills -> codex + claude-code + kimi-code-cli =="
"$BIN_DST/ahelpa" install-skill --source "$PROJECT_ROOT/skill"

echo "== deployed =="
"$BIN_DST/ahelpa" version
