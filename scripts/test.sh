#!/usr/bin/env bash
# Full suite: test files in parallel workers, then the files below in a second,
# five-worker pass. Each passes alone but misses its own time limit when the
# full parallel run saturates the CPU; together they mostly wait on processes:
#   codex-capabilities         help probes with 1-2 s timeouts
#   daemon-recovery            a CPU-bound loop with a 10 s timeout
#   integration, launch        a real claude TUI must show its turn in time
#   review-fingerprint-bounds  git must reach a fixture within a 1-2 s deadline
# One list feeds both runs, so a file cannot be skipped by one and missed by the other.
set -euo pipefail
cd "$(dirname "$0")/.."

timing_bound=(codex-capabilities daemon-recovery integration launch review-fingerprint-bounds)
ignore=()
files=()
for name in "${timing_bound[@]}"; do
  ignore+=("--path-ignore-patterns=tests/$name.test.ts")
  files+=("./tests/$name.test.ts")
done

bun test --parallel "${ignore[@]}"
bun test --parallel "${files[@]}"
