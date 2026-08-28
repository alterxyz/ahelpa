#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

CLI="bun run src/cli.ts"
CLOSURE_RUNTIME_ROOT="$(mktemp -d /tmp/ahelpa-closure-runtime.XXXXXX)"
export AHELPA_HOME="$CLOSURE_RUNTIME_ROOT/state"
export AHELPA_TMP_DIR="$CLOSURE_RUNTIME_ROOT/tmp"
GATE_LOG_DIR="$CLOSURE_RUNTIME_ROOT/logs"
mkdir -p "$GATE_LOG_DIR"
GATE_FIXTURE_PROJECT="$PROJECT_ROOT/tests/fixtures/closure"
GATE_SESSION=""
GATE_TOKEN=""
GATE_DELIVERY=""

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
  local wait_status
  local capture_output
  local passed=0

  echo
  echo "== closure gate > $agent =="
  local gate_project="$GATE_FIXTURE_PROJECT"
  # Claude review of this branch is explicitly authorized and the repository
  # root is stable. Reuse it instead of creating disposable trust paths.
  if [ "$agent" = "claude-code" ]; then
    gate_project="$PROJECT_ROOT"
  fi
  launch_output="$($CLI launch "$agent" --task "$task" --project "$gate_project")"

  session_id="$(json_field "$launch_output" "sessionId")"
  owner_token="$(json_field "$launch_output" "ownerToken")"
  GATE_SESSION="$session_id"
  GATE_TOKEN="$owner_token"
  GATE_DELIVERY="$gate_project/.ahelpa/$session_id"

  if [ -z "$session_id" ] || [ -z "$owner_token" ]; then
    fail "Failed to parse launch output for $agent"
  fi
  echo "launched > $agent ($session_id)"

  # Observe the full short-task loop. A non-empty pane is not enough: an empty
  # welcome prompt can hide a launch-send failure.
  if ! wait_output="$($CLI wait "$session_id" --timeout 180)"; then
    fail "wait failed for $agent session $session_id"
  fi
  printf '%s\n' "$wait_output" >"$GATE_LOG_DIR/wait-$agent.json"
  echo "$wait_output"
  wait_status="$(json_field "$wait_output" "status")"

  # Capture early output to verify prompt path is healthy.
  if ! capture_output="$($CLI capture "$session_id" --token "$owner_token" --lines 120)"; then
    fail "capture failed for $agent session $session_id"
  fi
  printf '%s\n' "$capture_output" >"$GATE_LOG_DIR/capture-$agent.txt"
  if [ ! -s "$GATE_LOG_DIR/capture-$agent.txt" ]; then
    fail "capture output was empty for $agent session $session_id"
  fi

  if [ "$wait_status" = "idle" ] \
    && grep -q "$expected_marker" "$GATE_LOG_DIR/capture-$agent.txt"; then
    passed=1
  elif [ -n "$accepted_error" ] \
    && { grep -q "$accepted_error" "$GATE_LOG_DIR/wait-$agent.json" \
      || grep -q "$accepted_error" "$GATE_LOG_DIR/capture-$agent.txt"; }; then
    echo "warn > $agent reached the helper and hit an environment/account error"
    passed=1
  fi

  if ! $CLI kill "$session_id" --token "$owner_token" >"$GATE_LOG_DIR/kill-$agent.txt"; then
    fail "kill failed for $agent session $session_id"
  fi
  GATE_SESSION=""
  GATE_TOKEN=""
  rm -rf -- "$GATE_DELIVERY"
  GATE_DELIVERY=""
  rmdir "$gate_project/.ahelpa" >/dev/null 2>&1 || true

  if [ "$passed" -ne 1 ]; then
    fail "did not observe expected marker '$expected_marker' for $agent session $session_id"
  fi

  echo "pass > $agent ($session_id)"
}

KIMI_GATE_PROJECT="$GATE_FIXTURE_PROJECT"
KIMI_GATE_SESSION_1=""
KIMI_GATE_TOKEN_1=""
KIMI_GATE_SESSION_2=""
KIMI_GATE_TOKEN_2=""
KIMI_GATE_DELIVERY_1=""
KIMI_GATE_DELIVERY_2=""

cleanup_gate() {
  if [ -n "$GATE_SESSION" ] && [ -n "$GATE_TOKEN" ]; then
    $CLI kill "$GATE_SESSION" --token "$GATE_TOKEN" >/dev/null 2>&1 || true
  fi
  if [ -n "$KIMI_GATE_SESSION_2" ] && [ -n "$KIMI_GATE_TOKEN_2" ]; then
    $CLI kill "$KIMI_GATE_SESSION_2" --token "$KIMI_GATE_TOKEN_2" >/dev/null 2>&1 || true
  fi
  if [ -n "$KIMI_GATE_SESSION_1" ] && [ -n "$KIMI_GATE_TOKEN_1" ]; then
    $CLI kill "$KIMI_GATE_SESSION_1" --token "$KIMI_GATE_TOKEN_1" >/dev/null 2>&1 || true
  fi
  if [ -n "$GATE_DELIVERY" ] && [ -d "$GATE_DELIVERY" ]; then
    rm -rf -- "$GATE_DELIVERY"
  fi
  if [ -n "$KIMI_GATE_DELIVERY_2" ] && [ -d "$KIMI_GATE_DELIVERY_2" ]; then
    rm -rf -- "$KIMI_GATE_DELIVERY_2"
  fi
  if [ -n "$KIMI_GATE_DELIVERY_1" ] && [ -d "$KIMI_GATE_DELIVERY_1" ]; then
    rm -rf -- "$KIMI_GATE_DELIVERY_1"
  fi
  rmdir "$KIMI_GATE_PROJECT/.ahelpa" >/dev/null 2>&1 || true
  $CLI daemon stop >/dev/null 2>&1 || true
  if [ -n "$CLOSURE_RUNTIME_ROOT" ] && [ -d "$CLOSURE_RUNTIME_ROOT" ]; then
    rm -rf -- "$CLOSURE_RUNTIME_ROOT"
  fi
}

trap cleanup_gate EXIT

run_kimi_resume_gate() {
  local context_marker="KIMI_CONTEXT_ALPHA_7391"
  local first_output
  local first_wait
  local first_status
  local first_capture
  local resume_output
  local second_wait
  local second_status
  local second_capture
  local second_turn_file="$GATE_LOG_DIR/capture-kimi-second-turn.txt"

  echo
  echo "== closure gate > kimi (task + resume) =="
  first_output="$($CLI launch kimi \
    --task "Remember the context marker $context_marker. Print gate-kimi-first, then print [AHELPA:DONE] on its own line." \
    --project "$KIMI_GATE_PROJECT")"
  KIMI_GATE_SESSION_1="$(json_field "$first_output" "sessionId")"
  KIMI_GATE_TOKEN_1="$(json_field "$first_output" "ownerToken")"
  KIMI_GATE_DELIVERY_1="$KIMI_GATE_PROJECT/.ahelpa/$KIMI_GATE_SESSION_1"
  echo "launched > kimi ($KIMI_GATE_SESSION_1)"

  first_wait="$($CLI wait "$KIMI_GATE_SESSION_1" --timeout 500)"
  echo "$first_wait"
  first_status="$(json_field "$first_wait" "status")"
  if ! first_capture="$($CLI capture "$KIMI_GATE_SESSION_1" --token "$KIMI_GATE_TOKEN_1" --lines 160)"; then
    fail "capture failed for Kimi first turn"
  fi
  printf '%s\n' "$first_capture" > "$GATE_LOG_DIR/capture-kimi-first.txt"
  if [ "$first_status" != "idle" ]; then
    tail -n 120 "$GATE_LOG_DIR/capture-kimi-first.txt" >&2
    fail "Kimi first turn did not settle successfully (status: $first_status)"
  fi
  if ! grep -q 'gate-kimi-first' "$GATE_LOG_DIR/capture-kimi-first.txt"; then
    fail "Kimi first turn did not complete"
  fi
  if ! grep -q 'Session:.*session_\|To resume this session: kimi -r session_' \
    "$GATE_LOG_DIR/capture-kimi-first.txt"; then
    fail "Kimi did not expose a session_* resume token"
  fi

  $CLI kill "$KIMI_GATE_SESSION_1" --token "$KIMI_GATE_TOKEN_1" >"$GATE_LOG_DIR/kill-kimi-first.txt"
  resume_output="$($CLI resume "$KIMI_GATE_SESSION_1" --token "$KIMI_GATE_TOKEN_1")"
  KIMI_GATE_SESSION_1=""
  KIMI_GATE_TOKEN_1=""
  KIMI_GATE_SESSION_2="$(json_field "$resume_output" "sessionId")"
  KIMI_GATE_TOKEN_2="$(json_field "$resume_output" "ownerToken")"
  KIMI_GATE_DELIVERY_2="$KIMI_GATE_PROJECT/.ahelpa/$KIMI_GATE_SESSION_2"
  echo "resumed > kimi ($KIMI_GATE_SESSION_2)"

  $CLI send "$KIMI_GATE_SESSION_2" \
    'SECOND_TURN_QUERY: Print the exact context marker I asked you to remember in the prior turn, then print gate-kimi-resumed, then print [AHELPA:DONE] on its own line.' \
    --token "$KIMI_GATE_TOKEN_2" >"$GATE_LOG_DIR/send-kimi.txt"
  second_wait="$($CLI wait "$KIMI_GATE_SESSION_2" --timeout 500)"
  echo "$second_wait"
  second_status="$(json_field "$second_wait" "status")"
  if ! second_capture="$($CLI capture "$KIMI_GATE_SESSION_2" --token "$KIMI_GATE_TOKEN_2" --lines 500)"; then
    fail "capture failed for resumed Kimi turn"
  fi
  printf '%s\n' "$second_capture" > "$GATE_LOG_DIR/capture-kimi-resumed.txt"
  if [ "$second_status" != "idle" ]; then
    tail -n 160 "$GATE_LOG_DIR/capture-kimi-resumed.txt" >&2
    fail "resumed Kimi turn did not settle successfully (status: $second_status)"
  fi
  sed -n '/SECOND_TURN_QUERY/,$p' "$GATE_LOG_DIR/capture-kimi-resumed.txt" > "$second_turn_file"
  if ! grep -q "$context_marker" "$second_turn_file"; then
    fail "resumed Kimi turn did not retain prior context"
  fi
  if ! grep -q 'gate-kimi-resumed' "$second_turn_file"; then
    fail "resumed Kimi turn did not complete"
  fi

  $CLI kill "$KIMI_GATE_SESSION_2" --token "$KIMI_GATE_TOKEN_2" >"$GATE_LOG_DIR/kill-kimi-resumed.txt"
  rm -rf -- "$KIMI_GATE_DELIVERY_2" "$KIMI_GATE_DELIVERY_1"
  rmdir "$KIMI_GATE_PROJECT/.ahelpa" >/dev/null 2>&1 || true
  echo "pass > kimi task, session token, resume readiness, and context continuity"
  KIMI_GATE_SESSION_2=""
  KIMI_GATE_TOKEN_2=""
  KIMI_GATE_DELIVERY_2=""
  KIMI_GATE_DELIVERY_1=""
}

echo "== closure gate start =="

$CLI help >"$GATE_LOG_DIR/cli.txt"

bun run test
bun run typecheck
bun run build

run_gate claude-code 'Print gate-claude, then print [AHELPA:DONE] on its own line.' 'gate-claude' 'Your account does not have access to Claude Code\|weekly limit\|session limit'
run_gate codex 'Print gate-codex, then print [AHELPA:DONE] on its own line.' 'gate-codex'
run_kimi_resume_gate

echo
echo "== closure gate done =="
