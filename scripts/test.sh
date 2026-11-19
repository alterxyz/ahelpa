#!/usr/bin/env bash
# Full suite: test files in parallel workers, then the files below in a second,
# small parallel pass. Each passes alone but misses its own time limit when the
# full parallel run saturates the CPU; together they mostly wait on processes:
#   codex-capabilities         the product's 1 s help-probe budget, inside a subprocess
#   review-fingerprint-bounds  git must reach a fixture within a 1-2 s deadline
# One list feeds both runs, so a file cannot be skipped by one and missed by the other.
set -euo pipefail
cd "$(dirname "$0")/.."

timing_bound=(codex-capabilities review-fingerprint-bounds)
ignore=()
files=()
for name in "${timing_bound[@]}"; do
  ignore+=("--path-ignore-patterns=tests/$name.test.ts")
  files+=("./tests/$name.test.ts")
done

bun test --parallel "${ignore[@]}"
bun test --parallel "${files[@]}"
