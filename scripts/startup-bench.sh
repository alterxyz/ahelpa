#!/usr/bin/env bash
# Startup benchmark for ahelpa helper names (makes real model calls).
# Usage: bash scripts/startup-bench.sh [--project <trusted git repo>] [--rounds N] [--out file.csv] [name ...]
# Runs one helper at a time, rotating the start name each round, with a trivial task.
set -euo pipefail
PROJECT=$PWD ROUNDS=3 OUT=startup-bench.csv NAMES=()
while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT=$2; shift 2 ;;
    --rounds) ROUNDS=$2; shift 2 ;;
    --out) OUT=$2; shift 2 ;;
    *) NAMES+=("$1"); shift ;;
  esac
done
[ ${#NAMES[@]} -gt 0 ] || NAMES=(claude codex gemini kimi mistral deepseek deepseek-pi)
TASK='Startup benchmark. Write your summary.md containing only the line `ok`. Do not read, run, or change anything else.'
now() { python3 -c 'import time; print(f"{time.time():.3f}")'; }
since() { python3 -c "print(round($2 - $1, 1))"; }
echo "round,name,session,model,effort,status,launch_s,wrote_s,done_s" > "$OUT"
for round in $(seq 1 "$ROUNDS"); do
  for i in "${!NAMES[@]}"; do
    name=${NAMES[$(( (i + round - 1) % ${#NAMES[@]} ))]}
    t0=$(now)
    out=$(cd "$PROJECT" && ahelpa launch "$name" --task "$TASK" --project "$PROJECT" --label "startup-bench $name r$round" 2>&1) || true
    t1=$(now)
    id=$(printf '%s' "$out" | jq -r '.sessionId // empty' 2>/dev/null || true)
    if [ -z "$id" ]; then echo "$round,$name,,,,launch_failed,$(since "$t0" "$t1"),," >> "$OUT"; continue; fi
    tok=$(printf '%s' "$out" | jq -r .ownerToken)
    status=$(cd "$PROJECT" && ahelpa wait "$id" --timeout 400 2>/dev/null | jq -r '.status // "unknown"') || status=unknown
    t2=$(now)
    summary="$PROJECT/.ahelpa/$id/summary.md" # ponytail: main-checkout project; a linked worktree keeps results elsewhere
    wrote=$(python3 -c "import os,sys; p=sys.argv[1]; print(round(os.path.getmtime(p)-$t0,1) if os.path.exists(p) else '')" "$summary")
    echo "$round,$name,$id,$(printf '%s' "$out" | jq -r '.model // "native"'),$(printf '%s' "$out" | jq -r '.effort // "native"'),$status,$(since "$t0" "$t1"),$wrote,$(since "$t0" "$t2")" >> "$OUT"
    (cd "$PROJECT" && ahelpa kill "$id" --token "$tok" >/dev/null 2>&1) || true
  done
done
python3 - "$OUT" <<'EOF'
import csv, statistics as st, sys
rows = [r for r in csv.DictReader(open(sys.argv[1])) if r["status"] != "launch_failed"]
names = list(dict.fromkeys(r["name"] for r in rows))
med = lambda k, n: st.median(float(r[k]) for r in rows if r["name"] == n and r[k])
print(f"{'name':12} {'launch':>7} {'wrote':>7} {'wait':>7}  (median seconds, {sys.argv[1]})")
for n in names:
    print(f"{n:12} {med('launch_s', n):7.1f} {med('wrote_s', n):7.1f} {med('done_s', n):7.1f}")
EOF
