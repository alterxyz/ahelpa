#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="${AHELPA_GATE_CLI:-$PROJECT_ROOT/dist/ahelpa}"

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
      const value = JSON.parse(fs.readFileSync(0, "utf8"))[process.argv[1]];
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
        : phase === "ready"
          ? session?.status === "needs_attention"
          : !session || session.status === "dead";
      if (!valid) process.exit(1);
    } catch { process.exit(1); }
  ' "$session_id" "$phase"
}

check_kimi_resume_id() {
  printf '%s' "$1" | bun -e '
    try {
      const fs = require("fs");
      const sessions = JSON.parse(fs.readFileSync(0, "utf8"));
      const session = sessions.find((entry) => entry.id === process.argv[1]);
      if (!/^session_[A-Za-z0-9._-]+$/.test(session?.agentResumeId ?? "")) process.exit(1);
    } catch { process.exit(1); }
  ' "$2"
}

# A subshell scopes all state and cleanup to the driver launched by this run.
run_gate() (
  # Bash 3 discards function-local variables before an EXIT trap after a
  # nested function exits, so cleanup state belongs to this subshell scope.
  agent="$1"
  label="$agent"
  expected_marker="gate-$agent"
  task="Write exactly $expected_marker followed by a newline to summary.md in your assigned result directory. Then output [AHELPA:DONE] on its own line."
  task="$task Only read the assigned task file and write within the assigned result directory; do not inspect other projects, home directories, or global ahelpa state."
  project="${GATE_FIXTURE_PROJECT:-$GATE_DIR/project-$agent}"
  if [ "$agent" = "claude-code" ] && [ -n "${GATE_CLAUDE_PROJECT:-}" ]; then
    project="$GATE_CLAUDE_PROJECT"
  fi
  session_id=""
  owner_token=""
  delivery=""
  cleaned=0
  wait_seconds=180
  if [ "$agent" = "kimi" ]; then
    context_marker="$(bun -e 'process.stdout.write(crypto.randomUUID())')"
    task="Remember this context marker for our next turn: $context_marker. $task"
    wait_seconds=500
  fi

  preserve_delivery() {
    if [ -n "$delivery" ] && [ -d "$delivery" ]; then
      mkdir -p "$GATE_DIR/result-$label" || return 1
      cp -R "$delivery/." "$GATE_DIR/result-$label/" || return 1
      if [ "$cleaned" -eq 1 ]; then
        rm -rf -- "$delivery" || return 1
        rmdir "$project/.ahelpa" >/dev/null 2>&1 || true
      fi
    fi
  }

  cleanup_gate_session() {
    local result=$?
    trap - EXIT
    if [ "$cleaned" -eq 0 ] && [ -n "$session_id" ] && [ -n "$owner_token" ]; then
      if ! "$CLI" kill "$session_id" --token "$owner_token" >"$GATE_DIR/kill-$label.txt" 2>&1; then
        echo "cleanup failed for $agent session $session_id; see $GATE_DIR/kill-$label.txt" >&2
        result=1
      elif tmux has-session -t "$session_id" 2>/dev/null; then
        echo "cleanup left tmux session $session_id alive; its result directory was retained" >&2
        result=1
      else
        cleaned=1
      fi
    fi
    if ! preserve_delivery; then result=1; fi
    exit "$result"
  }
  trap cleanup_gate_session EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  take_session() {
    session_id="$(json_field "$1" sessionId)"
    owner_token="$(json_field "$1" ownerToken)"
    # Never construct a cleanup path from an invalid session identifier.
    if [[ ! "$session_id" =~ ^[A-Za-z0-9_-]+$ ]]; then fail "Invalid session ID for $agent"; fi
    delivery="$project/.ahelpa/$session_id"
    cleaned=0
    echo "session > $session_id"
  }

  verify_completion() {
    if ! wait_output="$("$CLI" wait "$session_id" --timeout "$wait_seconds")"; then
      fail "wait failed for $agent session $session_id"
    fi
    printf '%s\n' "$wait_output" >"$GATE_DIR/wait-$label.json"
    echo "$wait_output"
    # Diagnostic only; works even after the daemon has reclaimed tmux.
    "$CLI" logs "$session_id" --token "$owner_token" >"$GATE_DIR/logs-$label.txt" 2>&1 || true
    if [ "$(json_field "$wait_output" sessionId)" != "$session_id" ] \
      || [ "$(json_field "$wait_output" status)" != "idle" ]; then
      fail "wait did not observe successful completion for $agent session $session_id"
    fi
    check_output="$("$CLI" check)"
    printf '%s\n' "$check_output" >"$GATE_DIR/check-$label.json"
    if ! check_session_status "$check_output" "$session_id" completed; then
      fail "check did not observe completed $agent session $session_id"
    fi
    if ! bun -e '
      try {
        const fs = require("fs");
        const [path, marker] = process.argv.slice(1);
        if (fs.readFileSync(path, "utf8") !== marker + "\n") process.exit(1);
      } catch { process.exit(1); }
    ' "$delivery/summary.md" "$expected_marker"; then
      fail "missing or incorrect summary for $agent session $session_id"
    fi
  }

  reclaim_session() {
    if ! "$CLI" kill "$session_id" --token "$owner_token" >"$GATE_DIR/kill-$label.txt" 2>&1; then
      fail "kill failed for $agent session $session_id"
    fi
    if tmux has-session -t "$session_id" 2>/dev/null; then
      fail "kill left tmux session $session_id alive"
    fi
    if ! check_session_status "$("$CLI" check)" "$session_id" killed; then
      fail "check still reports an active $agent session after kill"
    fi
    cleaned=1
    preserve_delivery
  }

  echo
  echo "== closure gate > $agent =="
  mkdir -p "$project"
  launch_output="$("$CLI" launch "$agent" --task "$task" --project "$project")"
  take_session "$launch_output"
  verify_completion
  if [ "$agent" = "kimi" ] && ! check_kimi_resume_id "$check_output" "$session_id"; then
    fail "Kimi did not retain a native session resume ID"
  fi
  reclaim_session

  if [ "$agent" = "kimi" ]; then
    prior_session="$session_id"
    resume_output="$("$CLI" resume "$session_id" --token "$owner_token")"
    label="kimi-resumed"
    take_session "$resume_output"
    if [ "$session_id" = "$prior_session" ]; then fail "Kimi resume reused the old helper ID"; fi
    if ! check_session_status "$("$CLI" check)" "$session_id" ready; then
      fail "Kimi resume did not reach needs_attention for a follow-up task"
    fi
    if [ -e "$delivery/summary.md" ]; then fail "Kimi resumed summary already exists before its new task"; fi
    expected_marker="gate-kimi-resumed:$context_marker"
    cat >"$GATE_DIR/kimi-resume-task.md" <<'TASK'
Recall the exact context marker from our prior conversation without reading prior task files, result files, other projects, home directories, or global ahelpa state. Write exactly gate-kimi-resumed: followed immediately by that marker and a newline to summary.md in your assigned result directory. Then output [AHELPA:DONE] on its own line. Only write within that assigned result directory.
TASK
    "$CLI" task "$session_id" --file "$GATE_DIR/kimi-resume-task.md" --token "$owner_token" >"$GATE_DIR/task-kimi-resumed.txt"
    verify_completion
    reclaim_session
    echo "pass > kimi resume readiness, new turn, and context continuity"
  fi
  echo "pass > $agent ($session_id)"
)

# The same bounded integration checks can verify a compiled development binary
# or the installed binary, always against private runtime roots.
run_integration_gate() (
  case "$CLI" in /*) ;; *) fail "AHELPA_GATE_CLI must be an absolute executable path" ;; esac
  if [ ! -x "$CLI" ]; then fail "Gate CLI is not executable: $CLI"; fi
  GATE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ahelpa-closure-gate.XXXXXX")"
  export AHELPA_HOME="$GATE_DIR/state"
  export AHELPA_TMP_DIR="$GATE_DIR/runtime"
  GATE_FIXTURE_PROJECT="$PROJECT_ROOT/tests/fixtures/closure"
  GATE_CLAUDE_PROJECT="$PROJECT_ROOT"
  cleanup_gate_runtime() {
    local result=$?
    trap - EXIT
    if ! "$CLI" daemon stop >"$GATE_DIR/daemon-stop.txt" 2>&1; then result=1; fi
    exit "$result"
  }
  trap cleanup_gate_runtime EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  echo "evidence > $GATE_DIR"
  "$CLI" help >"$GATE_DIR/cli.txt"
  "$CLI" version >"$GATE_DIR/version.txt"
  run_gate claude-code
  run_gate codex
  run_gate kimi
)

main() {
  cd "$PROJECT_ROOT"
  echo "== closure gate start =="
  bun run test
  bun run typecheck
  bun run build
  run_integration_gate
  echo
  echo "== closure gate done =="
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main
fi
