#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$PROJECT_ROOT/dist/ahelpa"

fail() {
  echo "✖ $1" >&2
  exit 1
}

json_field() {
  local json="$1"
  local field="$2"
  printf '%s' "$json" | bun -e '
    try {
      const fs = require("fs");
      const field = process.argv[1];
      const payload = JSON.parse(fs.readFileSync(0, "utf8"));
      const value = payload[field];
      if (typeof value !== "string" || value.length === 0) process.exit(1);
      process.stdout.write(value);
    } catch { process.exit(1); }
  ' "$field"
}

check_session_status() {
  local output="$1"
  local session_id="$2"
  local phase="$3"
  printf '%s' "$output" | bun -e '
    try {
      const fs = require("fs");
      const [id, phase] = process.argv.slice(1);
      const sessions = JSON.parse(fs.readFileSync(0, "utf8"));
      if (!Array.isArray(sessions)) process.exit(1);
      const session = sessions.find((entry) => entry.id === id);
      const valid = phase === "completed"
        ? session && ["idle", "draining"].includes(session.status)
        : !session || session.status === "dead";
      if (!valid) process.exit(1);
    } catch { process.exit(1); }
  ' "$session_id" "$phase"
}

# A subshell scopes the EXIT trap to this driver, including failures in wait,
# validation, or diagnostics. Never clean sessions belonging to another run.
run_gate() (
  # Keep these in the subshell scope: Bash 3 discards function-local variables
  # before running its EXIT trap after a nested function calls exit.
  agent="$1"
  expected_marker="gate-$agent"
  task="Write exactly $expected_marker followed by a newline to summary.md in your assigned result directory. Then output [AHELPA:DONE] on its own line."
  project="$GATE_DIR/project-$agent"
  session_id=""
  owner_token=""
  cleaned=0

  cleanup_gate_session() {
    local result=$?
    trap - EXIT
    if [ "$cleaned" -eq 0 ] && [ -n "$session_id" ] && [ -n "$owner_token" ]; then
      if ! "$CLI" kill "$session_id" --token "$owner_token" >"$GATE_DIR/kill-$agent.txt" 2>&1; then
        echo "cleanup failed for $agent session $session_id; see $GATE_DIR/kill-$agent.txt" >&2
        result=1
      fi
    fi
    exit "$result"
  }
  trap cleanup_gate_session EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  echo
  echo "== closure gate > $agent =="
  mkdir -p "$project"
  launch_output="$("$CLI" launch "$agent" --task "$task" --project "$project")"

  session_id="$(json_field "$launch_output" "sessionId")"
  owner_token="$(json_field "$launch_output" "ownerToken")"

  if [ -z "$session_id" ] || [ -z "$owner_token" ]; then
    fail "Failed to parse launch output for $agent"
  fi
  echo "session > $session_id"

  if ! wait_output="$("$CLI" wait "$session_id" --timeout 180)"; then
    fail "wait failed for $agent session $session_id"
  fi
  printf '%s\n' "$wait_output" >"$GATE_DIR/wait-$agent.json"
  echo "$wait_output"

  # Logs are diagnostic only and work after the daemon has reclaimed tmux.
  # Echoed prompts, partial output, and account errors cannot prove success.
  "$CLI" logs "$session_id" --token "$owner_token" >"$GATE_DIR/logs-$agent.txt" 2>&1 || true
  if [ "$(json_field "$wait_output" "sessionId")" != "$session_id" ] \
    || [ "$(json_field "$wait_output" "status")" != "idle" ]; then
    fail "wait did not observe successful completion for $agent session $session_id"
  fi

  check_output="$("$CLI" check)"
  printf '%s\n' "$check_output" >"$GATE_DIR/check-$agent.json"
  if ! check_session_status "$check_output" "$session_id" completed; then
    fail "check did not observe completed $agent session $session_id"
  fi

  if ! bun -e '
    try {
      const fs = require("fs");
      const [path, marker] = process.argv.slice(1);
      if (fs.readFileSync(path, "utf8") !== marker + "\n") process.exit(1);
    } catch { process.exit(1); }
  ' "$project/.ahelpa/$session_id/summary.md" "$expected_marker"; then
    fail "missing or incorrect summary for $agent session $session_id"
  fi

  if ! "$CLI" kill "$session_id" --token "$owner_token" >"$GATE_DIR/kill-$agent.txt" 2>&1; then
    fail "kill failed for $agent session $session_id"
  fi
  if tmux has-session -t "$session_id" 2>/dev/null; then
    fail "kill left tmux session $session_id alive"
  fi
  check_output="$("$CLI" check)"
  if ! check_session_status "$check_output" "$session_id" killed; then
    fail "check still reports an active $agent session after kill"
  fi
  cleaned=1

  echo "pass > $agent ($session_id)"
)

main() {
  cd "$PROJECT_ROOT"
  echo "== closure gate start =="

  bun run test
  bun run typecheck
  bun run build

  GATE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ahelpa-closure-gate.XXXXXX")"
  echo "evidence > $GATE_DIR"
  "$CLI" help >"$GATE_DIR/cli.txt"

  run_gate claude-code
  run_gate codex

  echo
  echo "== closure gate done =="
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main
fi
