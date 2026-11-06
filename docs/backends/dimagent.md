# Candidate card: dimAgent

English only: a dated evidence record for agents, not a user guide. Principles and funnel are in [Helper backends](../backends.md).

- **Evaluated:** 2026-11-06
- **Class:** Helper backend (the `dim` / `dima` coding CLI) inside a wider product family. Wrappers are evaluated by the agent underneath, so the CLI is what counts.
- **Verdict:** **Deferred.** The CLI is mid-rewrite and ships under two names; a driver would have to be rewritten.
- **Stopped at:** Funnel step 2 (maturity of the command surface). Steps 3-4 were not examined.
- **Version seen:** npm `dimcode` 0.5.24 (beta channel, updated 2026-11-04); Rust alpha `dimcode-alpha` with the `dima` command, announced 2026-11-05.
- **Re-evaluate when:** The Rust implementation ships under the existing `dimcode` package and `dim` command at a non-alpha tag (the project says that is the plan), or the user asks for it.

## What it is

"DimAgent" names several things from the same team (the vendor appears as Arcships; GitHub organization `arcships`):

1. **`dimcode`** (npm; commands `dim` and `dimcode`): a TypeScript coding-agent CLI with a TUI, one-shot `dim exec`, and `dim acp`. The docs call it a multi-model CLI and desktop coding agent. Bring your own provider keys (30+ providers, local models included).
2. **`dimcode-alpha`** (command `dima`): the open-sourced Rust rewrite, an event-timeline agent harness (repository `arcships/dim`, MIT).
3. **DimAgent Desktop** (macOS, Windows, Linux): a desktop client; the Arch User Repository package lists a proprietary EULA.
4. **dimagent.com**: a marketing site for a broader multi-agent "AI teammate" product (research, documents, data, orchestration, model routing), not a coding-CLI page. Whether it is operated by the same team as the CLI is Unverified.

## Facts

Fetched 2026-11-06 unless noted.

- Docs (dimcode.dev and dimagent.cn serve the same content): `dim` TUI; `dim exec` with `--policy full-access|read-only`, `--verify "<cmd>"`, `--stdin`, `--json`; `dim acp` for ACP editors; tool approvals `auto`, `approve-for-me`, `normal`; local state under `~/.dimcode/v2/` (SQLite, MCP config, credentials), relocatable with `DIMCODE_HOME`; `/resume` and `dim session list`; plugins, MCP, skills, hooks, and subagents are listed as features.
- npm page for `dimcode`: version 0.5.24 on the beta channel, about 2,800 weekly downloads, created 2026-01-21; platform sub-packages for macOS (arm64, x64), Linux (x64, arm64), and Windows. The docs say `npm install -g dimcode@latest` while the npm README recommends the beta channel. The desktop version is quoted inconsistently across pages (0.9.8, 0.9.32, and an AUR package at 0.9.20 dated 2026-09-03).
- Launch post on DEV Community, 2026-11-05, from Arcships: open-sourcing "dim", the Rust alpha (`npm install -g dimcode-alpha@alpha`, command `dima`). It states that `dimcode` remains the TypeScript CLI, both can coexist with separate data, and suggests starting with `dima --permission read-only` because plugins, hooks, and MCP can execute code.
- The `arcships/dim` README (read from search highlights, not in full): MIT; the plan is to ship the Rust implementation through the `dimcode` package and its `dim` command; `dima --prompt TEXT` runs a single turn, `dima acp` serves ACP, `/resume` reconnects; an App Server hosts sessions for clients.

## Grid

Not examined. The documentation lists resume (`/resume`, `dim session list`), a read-only policy (`--policy read-only`, `--permission read-only` in the alpha), ACP, and hooks, but nothing was run and no column can be filled with a verified value.

## Unverified

Everything at funnel steps 3-4. Also: the license of the TypeScript CLI, the relationship between dimagent.com and the CLI, how either CLI behaves inside tmux, its self-update behavior, and its terms for automated use.

## Why this verdict

Eligibility looks fine on its face: bring-your-own keys, no account requirement (`dim auth login` is optional), macOS and Linux builds, and active development. What stops it is stability. Two CLIs with different names, flags, and data directories exist today, and the vendor intends to move the Rust implementation under the `dim` command. A driver built now would target a surface that is announced to change, and the project is days old at its alpha. Revisit once the rewrite lands.

## History

- 2026-11-06: deferred (this card). Sources: the two docs sites, the npm page, the AUR package page, dimagent.com, the DEV Community launch post, and the `arcships/dim` repository summary. No official source was found for pricing or the vendor relationship, and none was needed for the verdict.
