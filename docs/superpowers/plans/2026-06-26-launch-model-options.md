# Launch Model Options Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add launch-time model selection plus a small static `models [agent]` listing command for supported helper agents.

**Architecture:** Keep the CLI surface flat. `launch` accepts optional `--model` and `--effort` flags, passes them through `LaunchInput` to each driver, and drivers translate them into native agent CLI arguments. Model catalog data lives with drivers and is rendered through a new `models [agent]` command.

**Tech Stack:** Bun TypeScript CLI, existing command-contract registry, existing driver registry, Bun tests.

---

### Task 1: Launch Flags

**Files:**
- Modify: `tests/drivers.test.ts`
- Modify: `tests/launch.test.ts`
- Modify: `src/drivers/types.ts`
- Modify: `src/drivers/codex.ts`
- Modify: `src/drivers/claude-code.ts`
- Modify: `src/commands/launch.ts`
- Modify: `src/command-contract.ts`

- [x] **Step 1: Write failing tests**

Add driver tests asserting Codex emits `--model` and `-c model_reasoning_effort=...`, and Claude Code emits `--model` plus `--effort`. Add a `planLaunch` test asserting launch options flow into the final tmux command.

- [x] **Step 2: Run tests and verify failure**

Run: `bun test tests/drivers.test.ts tests/launch.test.ts`

Expected: FAIL because `LaunchOptions` and command wiring do not yet support `model` or `effort`.

- [x] **Step 3: Implement minimal launch flag plumbing**

Extend `LaunchOptions` and `LaunchInput` with `model?: string` and `effort?: string`. Add those flags to the `launch` contract and pass them into `planLaunch`. Append quoted native arguments in each driver.

- [x] **Step 4: Run targeted tests**

Run: `bun test tests/drivers.test.ts tests/launch.test.ts`

Expected: PASS.

### Task 2: Static Model Catalog

**Files:**
- Modify: `tests/command-contract.test.ts`
- Modify: `src/drivers/types.ts`
- Modify: `src/drivers/registry.ts`
- Modify: `src/drivers/codex.ts`
- Modify: `src/drivers/claude-code.ts`
- Modify: `src/command-contract.ts`

- [x] **Step 1: Write failing tests**

Add tests for `renderModelsText()` showing all agents, and filtered output for `codex`.

- [x] **Step 2: Run tests and verify failure**

Run: `bun test tests/command-contract.test.ts`

Expected: FAIL because `renderModelsText` and `models` command do not exist.

- [x] **Step 3: Implement minimal catalog rendering**

Add `modelCatalog` metadata to each driver. Add `getDriverCatalogs()` in the registry. Add `models [agent]` command and `renderModelsText(agent?)` in the command contract.

- [x] **Step 4: Run targeted tests**

Run: `bun test tests/command-contract.test.ts`

Expected: PASS.

### Task 3: Docs and Full Verification

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `docs/usage.md`
- Modify: `docs/zh-CN/usage.md`

- [x] **Step 1: Update docs**

Document `launch --model/--effort` and `models [agent]` in English and Chinese public docs.

- [x] **Step 2: Run full tests**

Run: `bun test`

Expected: PASS.

- [x] **Step 3: Inspect final diff**

Run: `git diff --stat && git diff --check`

Expected: no whitespace errors and only the planned files changed.
