#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

CLI="bun run src/cli.ts"

fail() {
  echo "✖ $1" >&2
  exit 1
}

json_field() {
  local json="$1"
  local field="$2"
  printf '%s' "$json" | bun -e '
    const fs = require("fs");
    const field = process.argv[1];
    const content = fs.readFileSync(0, "utf8").trim();
    if (!content) process.exit(1);
    const payload = JSON.parse(content);
    const value = payload[field];
    if (typeof value !== "string" || value.length === 0) process.exit(1);
    process.stdout.write(String(value));
  ' "$field"
}

run_gate() {
  local agent="$1"
  local task="$2"
  local expected_marker="$3"
  local accepted_error="${4:-}"
  local launch_output
  local session_id
  local owner_token
  local wait_output
  local capture_output
  local passed=0

  echo
  echo "== closure gate > $agent =="
  launch_output="$($CLI launch "$agent" --task "$task" --project /tmp)"
  echo "$launch_output"

  session_id="$(json_field "$launch_output" "sessionId")"
  owner_token="$(json_field "$launch_output" "ownerToken")"

  if [ -z "$session_id" ] || [ -z "$owner_token" ]; then
    fail "Failed to parse launch output for $agent"
  fi

  # Observe the full short-task loop. A non-empty pane is not enough: an empty
  # welcome prompt can hide a launch-send failure.
  if ! wait_output="$($CLI wait "$session_id" --timeout 180)"; then
    fail "wait failed for $agent session $session_id"
  fi
  printf '%s\n' "$wait_output" >"/tmp/ahelpa-closure-gate-wait-$agent.json"
  echo "$wait_output"

  # Capture early output to verify prompt path is healthy.
  if ! capture_output="$($CLI capture "$session_id" --token "$owner_token" --lines 120)"; then
    fail "capture failed for $agent session $session_id"
  fi
  printf '%s\n' "$capture_output" >"/tmp/ahelpa-closure-gate-capture-$agent.txt"
  if [ ! -s "/tmp/ahelpa-closure-gate-capture-$agent.txt" ]; then
    fail "capture output was empty for $agent session $session_id"
  fi

  if printf '%s\n%s\n' "$wait_output" "$capture_output" | grep -q "$expected_marker"; then
    passed=1
  elif [ -n "$accepted_error" ] && printf '%s\n%s\n' "$wait_output" "$capture_output" | grep -q "$accepted_error"; then
    echo "warn > $agent reached the helper and hit an environment/account error"
    passed=1
  fi

  if ! $CLI kill "$session_id" --token "$owner_token" >/tmp/ahelpa-closure-gate-kill-$agent.txt; then
    fail "kill failed for $agent session $session_id"
  fi

  if [ "$passed" -ne 1 ]; then
    fail "did not observe expected marker '$expected_marker' for $agent session $session_id"
  fi

  echo "pass > $agent ($session_id)"
}

echo "== closure gate start =="

$CLI help >/tmp/ahelpa-closure-gate-cli.txt

bun run test
bun run typecheck
bun run build

run_gate claude-code 'Print gate-claude, then print [AHELPA:DONE] on its own line.' 'gate-claude' 'Your account does not have access to Claude Code\|weekly limit\|session limit'
run_gate codex 'Print gate-codex, then print [AHELPA:DONE] on its own line.' 'gate-codex'

echo
echo "== closure gate done =="
