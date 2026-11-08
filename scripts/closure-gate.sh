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

check_session_profile() {
  printf '%s' "$1" | bun -e '
    try {
      const fs = require("fs");
      const [id, role, model, effort] = process.argv.slice(1);
      const result = JSON.parse(fs.readFileSync(0, "utf8"));
      const session = Array.isArray(result)
        ? result.find((entry) => entry.id === id)
        : result.sessionId === id ? result : undefined;
      if (!session || session.role !== role || (session.model ?? "") !== model || (session.effort ?? "") !== effort) {
        process.exit(1);
      }
    } catch { process.exit(1); }
  ' "$2" "$3" "$4" "$5"
}

# A subshell scopes all state and cleanup to the driver launched by this run.
run_gate() (
  # Bash 3 discards function-local variables before an EXIT trap after a
  # nested function exits, so cleanup state belongs to this subshell scope.
  agent="$1"
  harness="$agent"
  case "$agent" in
    claude) harness="claude-code" ;;
    gemini) harness="agy" ;;
    mistral | deepseek) harness="vibe" ;;
    deepseek-pi) harness="pi" ;;
  esac
  agent_name="$agent"
  if [ "$harness" = "kimi" ]; then agent_name="Kimi"; fi
  if [ "$harness" = "pi" ]; then agent_name="Pi"; fi
  uuid_resume=0
  if [ "$harness" = "pi" ] || [ "$harness" = "agy" ] || [ "$harness" = "vibe" ]; then uuid_resume=1; fi
  requested_role="${2:-}"
  expected_role=""
  expected_model=""
  expected_effort=""
  case "$agent:$requested_role" in
    claude: | claude:advisor)
      expected_role="advisor"
      expected_model="claude-opus-5-5"
      expected_effort="xhigh"
      ;;
    claude:worker)
      expected_role="worker"
      expected_model="claude-sonnet-5-5"
      expected_effort="high"
      ;;
    codex: | codex:worker)
      expected_role="worker"
      expected_model="gpt-6-astra"
      expected_effort="medium"
      ;;
    deepseek-pi: | deepseek-pi:worker)
      expected_role="worker"
      expected_model="${AHELPA_GATE_PI_MODEL:-cc-switch-deep-seek/deepseek-flash}"
      expected_effort="${AHELPA_GATE_PI_EFFORT:-high}"
      ;;
    gemini: | gemini:worker)
      expected_role="worker"
      expected_model="gemini-4-argon"
      expected_effort="medium"
      ;;
    mistral: | mistral:worker)
      expected_role="worker"
      expected_model="mistral-large-4-0-3"
      expected_effort="high"
      ;;
    deepseek: | deepseek:worker)
      expected_role="worker"
      expected_model="deepseek-v4-1-flash-1017"
      expected_effort="high"
      ;;
    kimi:) ;;
    *) fail "Unsupported gate scenario: $agent $requested_role" ;;
  esac
  label="$agent"
  if [ -n "$expected_role" ]; then label="$agent-$expected_role"; fi
  expected_marker="gate-$label"
  task="Write exactly $expected_marker followed by a newline to summary.md in your assigned result directory. Then output [AHELPA:DONE] on its own line."
  task="$task Only read the assigned task file and write within the assigned result directory; do not inspect other projects, home directories, or global ahelpa state."
  project="${GATE_FIXTURE_PROJECT:-$GATE_DIR/project-$label}"
  if [ "$harness" = "claude-code" ] && [ -n "${GATE_CLAUDE_PROJECT:-}" ]; then
    project="$GATE_CLAUDE_PROJECT"
  fi
  session_id=""
  owner_token=""
  delivery=""
  real_delivery=""
  cleaned=0
  pi_native_id=""
  pi_lock=""
  pi_pids=""
  wait_seconds=180
  if [ "$harness" = "kimi" ] || [ "$harness" = "pi" ] || [ "$harness" = "agy" ] || [ "$harness" = "vibe" ]; then
    context_marker="$(bun -e 'process.stdout.write(crypto.randomUUID())')"
    task="Remember this context marker for our next turn: $context_marker. $task"
    wait_seconds=500
  fi

  preserve_delivery() {
    if [ -n "$delivery" ] && [ -d "$delivery" ]; then
      mkdir -p "$GATE_DIR/result-$label" || return 1
      cp -R "$delivery/." "$GATE_DIR/result-$label/" || return 1
      if [ "$cleaned" -eq 1 ]; then
        # In a linked worktree $delivery is a link; the results are in the main checkout.
        rm -rf -- "$delivery" "$real_delivery" || return 1
        rmdir "$project/.ahelpa" "$(dirname "$real_delivery")" >/dev/null 2>&1 || true
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
    real_delivery="$delivery"
    if [ -L "$delivery" ]; then real_delivery="$(cd -P "$delivery" && pwd -P)" || fail "Cannot resolve the result directory of $agent session $session_id"; fi
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
    if [ -n "$expected_role" ] && ! check_session_profile "$check_output" "$session_id" \
      "$expected_role" "$expected_model" "$expected_effort"; then
      fail "check did not retain expected role/model/effort for $label session $session_id"
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

  snapshot_pi_processes() {
    [ "$harness" = "pi" ] || return 0
    local pane_pids pi_snapshot
    pane_pids="$(tmux list-panes -t "$session_id" -F '#{pane_pid}')" || return 1
    pi_snapshot="$(ps -axo pid=,ppid= | bun -e '
      try {
        const fs = require("fs");
        const [panes, metadata, id, project] = process.argv.slice(1);
        const info = JSON.parse(fs.readFileSync(metadata, "utf8"));
        const path = require("path"), os = require("os");
        // Derive the native session directory independently (Pi 1.4 rules), never from metadata.
        const expand = value => value === "~" ? os.homedir() : value.startsWith("~/") ? path.join(os.homedir(), value.slice(2))
          : /^file:\/\//.test(value) ? require("url").fileURLToPath(value) : value;
        const cwd = fs.realpathSync(project);
        const agent = path.resolve(cwd, expand(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent")));
        const directory = path.join(agent, "sessions", "--" + cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-") + "--");
        if (info.lockPath !== path.join(directory, ".ahelpa-" + id + ".lock")) process.exit(1);
        const transcripts = fs.readdirSync(directory).filter(name => name.endsWith("_" + id + ".jsonl"));
        if (transcripts.length !== 1) process.exit(1);
        const fd = fs.openSync(path.join(directory, transcripts[0]), "r");
        let header;
        try {
          const buffer = Buffer.alloc(65536), size = fs.readSync(fd, buffer, 0, buffer.length, 0);
          const newline = buffer.indexOf(10);
          if (newline < 0 || newline >= size) throw new Error("Invalid session header");
          header = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
        } finally { fs.closeSync(fd); }
        if (header.type !== "session" || header.id !== id) process.exit(1);
        const roots = panes.trim().split(/\s+/).map(Number);
        if (!roots.length || roots.some(pid => !Number.isSafeInteger(pid) || pid <= 0)) process.exit(1);
        const rows = fs.readFileSync(0, "utf8").trim().split("\n").map(line => line.trim().split(/\s+/).map(Number));
        if (roots.some(pid => !rows.some(row => row[0] === pid))) process.exit(1);
        const pids = new Set(roots);
        let prior;
        do {
          prior = pids.size;
          for (const [pid, parent] of rows) if (pids.has(parent)) pids.add(pid);
        } while (pids.size !== prior);
        if (![info.bridgePid, info.childPid].every(pid => Number.isSafeInteger(pid) && pids.has(pid))) process.exit(1);
        process.stdout.write(JSON.stringify({ pids: [...pids].join("\n"), lockPath: info.lockPath }));
      } catch { process.exit(1); }
    ' "$pane_pids" "$delivery/pi-process.json" "$pi_native_id" "$project")" || return 1
    pi_pids="$(json_field "$pi_snapshot" pids)" || return 1
    pi_lock="$(json_field "$pi_snapshot" lockPath)" || return 1
    printf '%s\n' "$pi_pids" >"$GATE_DIR/pids-$label.txt"
  }

  snapshot_agy_processes() {
    if [ "$harness" = "agy" ]; then snapshot_agy_tree "${1:-}"; return; fi
    return 0
  }

  # Vibe's TUI owns its process tree. Record the pane's tree while the helper is
  # live (mid-turn: with the running sleep tool); kill must leave none of it.
  snapshot_vibe_processes() {
    [ "$harness" = "vibe" ] || return 0
    local pane_pids observed_pids
    pane_pids="$(tmux list-panes -t "$session_id" -F '#{pane_pid}')" || return 1
    observed_pids="$(ps -axo pid=,ppid=,comm= | bun -e '
      try {
        const [panes, mode] = process.argv.slice(1);
        const roots = panes.trim().split(/\s+/).map(Number);
        if (!roots.length || roots.some(pid => !Number.isSafeInteger(pid) || pid <= 0)) process.exit(1);
        const rows = require("fs").readFileSync(0, "utf8").trim().split("\n").map(line => {
          const [pid, parent, ...command] = line.trim().split(/\s+/);
          return [Number(pid), Number(parent), command.join(" ")];
        });
        const pids = new Set(roots);
        let prior;
        do {
          prior = pids.size;
          for (const [pid, parent] of rows) if (pids.has(parent)) pids.add(pid);
        } while (pids.size !== prior);
        const tree = rows.filter(([pid]) => pids.has(pid)).map(row => row[2]);
        if (!tree.some(command => /(?:^|\/)vibe(?:-rs)?$/.test(command))) process.exit(1);
        if (mode === "midturn" && !tree.some(command => /(?:^|\/)sleep$/.test(command))) process.exit(1);
        process.stdout.write([...pids].sort((a, b) => a - b).join("\n"));
      } catch { process.exit(1); }
    ' "$pane_pids" "${1:-}")" || return 1
    pi_pids="$observed_pids"
    printf '%s\n' "$pi_pids" >"$GATE_DIR/pids-$label.txt"
  }

  # Vibe prints its resume ID only when it exits; the daemon records it while
  # draining, until the drain ends the tmux session. Settlement shows idle first.
  await_vibe_resume_id() {
    local attempt
    for attempt in {1..30}; do
      if printf '%s' "$check_output" | bun -e '
        try {
          const session = JSON.parse(require("fs").readFileSync(0, "utf8")).find(entry => entry.id === process.argv[1]);
          if (!session?.agentResumeId) process.exit(1);
        } catch { process.exit(1); }
      ' "$session_id"; then return 0; fi
      if ! tmux has-session -t "$session_id" 2>/dev/null; then
        check_output="$("$CLI" check)"
        return 0
      fi
      sleep 1
      check_output="$("$CLI" check)"
    done
  }

  # agy runs its own TUI in the pane. Record the pane's whole process tree, which must
  # hold agy (and mid-turn its sleep tool); kill must leave none of those PIDs behind.
  snapshot_agy_tree() {
    local pane_pids observed_pids
    if pane_pids="$(tmux list-panes -t "$session_id" -F '#{pane_pid}')" && observed_pids="$(ps -axo pid=,ppid=,comm= | bun -e '
      try {
        const fs = require("fs");
        const [panes, mode] = process.argv.slice(1);
        const rows = fs.readFileSync(0, "utf8").trim().split("\n").map(line => {
          const [pid, parent, ...command] = line.trim().split(/\s+/);
          return [Number(pid), Number(parent), command.join(" ")];
        });
        const pids = new Set(panes.trim().split(/\s+/).map(Number));
        if (!pids.size || [...pids].some(pid => !Number.isSafeInteger(pid) || pid <= 0 || !rows.some(row => row[0] === pid))) process.exit(1);
        let prior;
        do {
          prior = pids.size;
          for (const [pid, parent] of rows) if (pids.has(parent)) pids.add(pid);
        } while (pids.size !== prior);
        const has = name => rows.some(([pid, , command]) => pids.has(pid) && new RegExp("(?:^|/)" + name + "$").test(command));
        if (!has("agy") || (mode === "midturn" && !has("sleep"))) process.exit(1);
        process.stdout.write([...pids].join("\n"));
      } catch { process.exit(1); }
    ' "$pane_pids" "${1:-}")" && [ -n "$observed_pids" ]; then
      pi_pids="$observed_pids"
      printf '%s\n' "$pi_pids" >"$GATE_DIR/pids-$label.txt"
      return 0
    fi
    # Mid-turn polling retries; a launch or resume snapshot has no second chance.
    if [ "${1:-}" = "midturn" ]; then return 1; fi
    fail "Cannot snapshot $agent agy process tree of a live helper"
  }

  # agy prints its conversation ID only on exit, which the daemon reads while draining.
  await_agy_resume_id() {
    local attempt
    for attempt in {1..15}; do
      check_output="$("$CLI" check)"
      if printf '%s' "$check_output" | bun -e '
        try {
          const sessions = JSON.parse(require("fs").readFileSync(0, "utf8"));
          const id = sessions.find(entry => entry.id === process.argv[1])?.agentResumeId;
          process.exit(typeof id === "string" && id.length > 0 ? 0 : 1);
        } catch { process.exit(1); }
      ' "$session_id"; then return 0; fi
      sleep 1
    done
  }

  verify_pi_reclaimed() {
    [ "$harness" = "pi" ] || [ "$harness" = "agy" ] || [ "$harness" = "vibe" ] || return 0
    [ -n "$pi_pids" ] || return 1
    if [ "$harness" = "pi" ] && [ -z "$pi_lock" ]; then return 1; fi
    local attempt
    for attempt in {1..20}; do
      # Process titles may hide RPC arguments; compare only the recorded PIDs.
      if { [ -z "$pi_lock" ] || [ ! -e "$pi_lock" ]; } && ps -axo pid=,ppid= | bun -e '
        const rows = require("fs").readFileSync(0, "utf8").trim().split("\n");
        const remaining = new Set(rows.map(line => Number(line.trim().split(/\s+/)[0])));
        const recorded = process.argv[1].trim().split(/\s+/).map(Number);
        process.exit(recorded.some(pid => remaining.has(pid)) ? 1 : 0);
      ' "$pi_pids"; then
        return 0
      fi
      sleep 0.5
    done
    return 1
  }

  retain_pi_identity() {
    pi_observed_id="$(printf '%s' "$1" | bun -e '
      try {
        const sessions = JSON.parse(require("fs").readFileSync(0, "utf8"));
        const id = sessions.find(entry => entry.id === process.argv[1])?.agentResumeId;
        // Vibe prints the first 8 hex digits of its session ID; older bridge sessions stored the full UUID.
        const short = process.argv[2] === "vibe" && /^[a-f0-9]{8}$/.test(id ?? "");
        if (typeof id !== "string" || !(short || /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id))) process.exit(1);
        process.stdout.write(id);
      } catch { process.exit(1); }
    ' "$session_id" "$harness")" || fail "$agent_name did not retain a native session UUID"
    if [ -n "$pi_native_id" ] && [ "$pi_native_id" != "$pi_observed_id" ]; then
      fail "$agent_name resume changed the native session UUID"
    fi
    pi_native_id="$pi_observed_id"

  }

  reclaim_session() {
    if ! snapshot_pi_processes; then fail "Cannot snapshot Pi process tree and lock before kill"; fi
    if ! "$CLI" kill "$session_id" --token "$owner_token" >"$GATE_DIR/kill-$label.txt" 2>&1; then
      fail "kill failed for $agent session $session_id"
    fi
    if tmux has-session -t "$session_id" 2>/dev/null; then
      fail "kill left tmux session $session_id alive"
    fi
    if ! check_session_status "$("$CLI" check)" "$session_id" killed; then
      fail "check still reports an active $agent session after kill"
    fi
    if ! verify_pi_reclaimed; then
      if [ "$harness" = "agy" ] || [ "$harness" = "vibe" ]; then fail "$agent process tree remains after kill"; fi
      fail "Pi child or session lock remains after kill"
    fi
    cleaned=1
    preserve_delivery
  }

  echo
  echo "== closure gate > $label =="
  mkdir -p "$project"
  launch_args=(launch "$agent" --task "$task" --project "$project")
  if [ -n "$requested_role" ]; then launch_args+=(--role "$requested_role"); fi
  if [ "$harness" = "pi" ]; then
    if [ -n "${AHELPA_GATE_PI_MODEL:-}" ]; then launch_args+=(--model "$expected_model"); fi
    if [ -n "${AHELPA_GATE_PI_EFFORT:-}" ]; then launch_args+=(--effort "$expected_effort"); fi
  fi
  launch_output="$("$CLI" "${launch_args[@]}")"
  take_session "$launch_output"
  if ! snapshot_agy_processes; then fail "Cannot snapshot $agent bridge and child of a live helper"; fi
  if ! snapshot_vibe_processes; then fail "Cannot snapshot $agent process tree of a live helper"; fi
  if [ -n "$expected_role" ] && ! check_session_profile "$launch_output" "$session_id" \
    "$expected_role" "$expected_model" "$expected_effort"; then
    fail "launch did not report expected role/model/effort for $label session $session_id"
  fi
  verify_completion
  if [ "$harness" = "kimi" ] && ! check_kimi_resume_id "$check_output" "$session_id"; then
    fail "Kimi did not retain a native session resume ID"
  fi
  if [ "$harness" = "agy" ]; then await_agy_resume_id; fi
  if [ "$harness" = "vibe" ]; then await_vibe_resume_id; fi
  if [ "$uuid_resume" -eq 1 ]; then retain_pi_identity "$check_output"; fi
  reclaim_session

  if [ "$harness" = "kimi" ] || [ "$harness" = "pi" ] || [ "$harness" = "agy" ] || [ "$harness" = "vibe" ]; then
    prior_session="$session_id"
    resume_output="$("$CLI" resume "$session_id" --token "$owner_token")"
    label="$agent-resumed"
    take_session "$resume_output"
    if [ "$session_id" = "$prior_session" ]; then fail "$agent_name resume reused the old helper ID"; fi
    if [ "$harness" != "vibe" ] && ! snapshot_agy_processes; then fail "Cannot snapshot $agent bridge and child of a live helper"; fi
    resume_check="$("$CLI" check)"
    if [ "$uuid_resume" -eq 1 ]; then retain_pi_identity "$resume_check"; fi
    if ! check_session_status "$resume_check" "$session_id" ready; then
      fail "$agent_name resume did not reach needs_attention for a follow-up task"
    fi
    if [ -e "$delivery/summary.md" ]; then fail "$agent_name resumed summary already exists before its new task"; fi
    expected_marker="gate-$agent-resumed:$context_marker"
    cat >"$GATE_DIR/$agent-resume-task.md" <<'TASK'
Recall the exact context marker from our prior conversation without reading prior task files, result files, other projects, home directories, or global ahelpa state. Write one line to summary.md in your assigned result directory. Construct it by concatenating the literal prefix `gate-kimi-resumed:` and the remembered UUID, then one newline. There must be NO SPACE after the colon or anywhere in the line. Do not include backticks, quotes, placeholders, or commentary. Before declaring completion, check only the new summary.md for this exact format. Then output [AHELPA:DONE] on its own line. Only write within that assigned result directory.
TASK
    sed "s/gate-kimi-resumed:/gate-$agent-resumed:/" "$GATE_DIR/$agent-resume-task.md" >"$GATE_DIR/$agent-task.md"
    mv "$GATE_DIR/$agent-task.md" "$GATE_DIR/$agent-resume-task.md"
    "$CLI" task "$session_id" --file "$GATE_DIR/$agent-resume-task.md" --token "$owner_token" >"$GATE_DIR/task-$agent-resumed.txt"
    if ! snapshot_vibe_processes; then fail "Cannot snapshot $agent process tree of a live helper"; fi
    verify_completion
    reclaim_session
    echo "pass > $agent resume readiness, new turn, and context continuity"
  fi
  if [ "$harness" = "vibe" ]; then
    prior_session="$session_id"
    resume_output="$("$CLI" resume "$session_id" --token "$owner_token")"
    label="$agent-midturn"
    take_session "$resume_output"
    if [ "$session_id" = "$prior_session" ]; then fail "Vibe resume reused the old helper ID"; fi
    resume_check="$("$CLI" check)"
    retain_pi_identity "$resume_check"
    if ! check_session_status "$resume_check" "$session_id" ready; then fail "Vibe mid-turn resume did not become ready"; fi
    cat >"$GATE_DIR/$agent-midturn-task.md" <<'TASK'
Run sleep 120 in the foreground using your shell tool and wait for it to finish. Do not run it in the background. Only after it finishes, print [AHELPA:DONE] on its own line.
TASK
    "$CLI" task "$session_id" --file "$GATE_DIR/$agent-midturn-task.md" --token "$owner_token" >"$GATE_DIR/task-$label.txt"
    observed=0
    for attempt in {1..60}; do
      if snapshot_vibe_processes midturn; then observed=1; break; fi
      sleep 1
    done
    if [ "$observed" -ne 1 ]; then fail "Vibe did not expose its process tree with the running sleep tool"; fi
    reclaim_session
  fi
  if [ "$harness" = "agy" ]; then
    # tmux's hangup reaches agy, which stops the tool it runs; nothing must survive the kill.
    prior_session="$session_id"
    resume_output="$("$CLI" resume "$session_id" --token "$owner_token")"
    label="$agent-midturn"
    take_session "$resume_output"
    if [ "$session_id" = "$prior_session" ]; then fail "$agent resume reused the old helper ID"; fi
    if ! check_session_status "$("$CLI" check)" "$session_id" ready; then fail "$agent mid-turn resume did not become ready"; fi
    printf '%s\n' "Run sleep 120 in the foreground using your shell tool and wait for it to finish. Only after it finishes, print [AHELPA:DONE] on its own line." >"$GATE_DIR/$agent-midturn-task.md"
    "$CLI" task "$session_id" --file "$GATE_DIR/$agent-midturn-task.md" --token "$owner_token" >"$GATE_DIR/task-$label.txt"
    observed=0
    for attempt in {1..60}; do
      if snapshot_agy_tree midturn; then observed=1; break; fi
      sleep 1
    done
    if [ "$observed" -ne 1 ]; then fail "$agent did not expose agy and its sleep tool mid-turn"; fi
    reclaim_session
    echo "pass > $agent mid-turn kill reclaims agy and its tool"
  fi
  echo "pass > $agent${expected_role:+-$expected_role} ($session_id)"
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
  run_gate claude
  run_gate claude worker
  run_gate codex
  if [ "${AHELPA_GATE_PI:-}" = 1 ]; then
    run_gate deepseek-pi
  else
    echo "skip > deepseek-pi (set AHELPA_GATE_PI=1 to include)"
  fi
  if [ "${AHELPA_GATE_AGY:-}" = 1 ]; then
    run_gate gemini
  else
    echo "skip > gemini (set AHELPA_GATE_AGY=1 to include)"
  fi
  if [ "${AHELPA_GATE_VIBE:-}" = 1 ]; then
    run_gate mistral
  else
    echo "skip > mistral (set AHELPA_GATE_VIBE=1 to include)"
  fi
  if [ "${AHELPA_GATE_DEEPSEEK:-}" = 1 ]; then
    run_gate deepseek
  else
    echo "skip > deepseek (set AHELPA_GATE_DEEPSEEK=1 to include)"
  fi
  # Kimi's live run is opt-in.
  if [ "${AHELPA_GATE_KIMI:-}" = 1 ]; then
    run_gate kimi
  else
    echo "skip > kimi (set AHELPA_GATE_KIMI=1 to include)"
  fi
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
