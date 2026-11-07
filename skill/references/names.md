# Helper names, routes, and fallback policies

Public names belong to ahelpa. A public name and its nicknames point to a harness ID plus launch defaults; they need not match the upstream product name. New database records store only the harness ID. Names and nicknames select the same profile and public session prefix. Resume uses the stored harness, model, and effort, preserving the old session ID prefix even if a public name later changes its route. Existing records are not migrated.

`ahelpa models` and unknown-name errors show the same complete directory; `ahelpa models <name>` adds model options. The registry in `src/drivers/registry.ts` is the runtime source of truth.

| Public name | Nicknames | Harness / stored ID | Default model / effort | Route | Prerequisites | Fallback policy |
| --- | --- | --- | --- | --- | --- | --- |
| `claude` | `claude-code` | Claude Code / `claude-code` | advisor/reviewer: `claude-opus-5-5` / `xhigh`; worker: `claude-sonnet-5-5` / `high` | Claude subscription | `claude` on PATH; sign in and trust the project interactively before launch | Repair subscription/login or project trust first; the host chooses another helper if needed. |
| `codex` | `gpt` | OpenAI Codex CLI / `codex` | worker/reviewer: `gpt-6-astra` / `medium` | ChatGPT subscription | `codex` on PATH and signed in | Restore login or wait for capacity/quota; the host chooses another helper if needed. |
| `gemini` | `agy`, `antigravity` | Google Antigravity CLI / `agy` | worker/reviewer: `gemini-4-argon` / `medium` | Google account | `agy` ≥ 1.5.2 and Node.js on PATH; sign in once | Repair Google sign-in or availability; the host chooses another helper if needed. |
| `kimi` | — | Kimi Code CLI / `kimi` | Native model; no effort or role preset | Kimi subscription | Kimi Code 2.x on PATH and signed in; configured model alias if explicitly selected | Repair subscription/login or configuration; the host chooses another helper if needed. |
| `mistral` | `vibe` | Mistral Vibe CLI / `vibe` | worker/reviewer: `mistral-large-4-0-3` / `high` | Mistral subscription via Vibe login | `vibe` ≥ 3.1.0 and Node.js on PATH; signed in with access to the model | Repair Mistral login or model access; the host chooses another helper if needed. |
| `deepseek` | `deepseek-vibe` | Mistral Vibe CLI / `vibe` | worker/reviewer: `deepseek-v4-1-flash-1017` / `high` | Mistral subscription via Vibe login | `vibe` ≥ 3.1.0 and Node.js on PATH; subscription includes this model | Subscription first. If the first turn reports `model unavailable (the Mistral subscription may not include it)` or authentication fails, the host may launch `deepseek-pi` through the API. |
| `deepseek-pi` | `pi` | Pi Coding Agent / `pi` | worker/reviewer: `cc-switch-deep-seek/deepseek-flash` / `high` | Official DeepSeek API | Pi ≥ 1.4.0 and Node.js; configure DeepSeek in CC-Switch and sync to Pi so provider `cc-switch-deep-seek` exists | API backup for `deepseek`. Repair CC-Switch/Pi provider or API credentials when unavailable; the host decides whether to return to the subscription route. |

Fallback is a disclosed policy, not runtime automation. It can describe subscription → API or API → subscription; current entries use subscription first for `deepseek` and its API backup. A different route can change cost, permissions, and native resume behavior. Start a new helper with an explicit handoff when changing routes; do not treat it as continuation of the old native session.

```bash
ahelpa launch deepseek --file ./task.md
# After inspecting a subscription/authentication failure and preparing the API route:
ahelpa launch deepseek-pi --file ./task.md
```

Explicit `--model` and `--effort` independently override role defaults. `claude` supports advisor, worker, and reviewer; other names except `kimi` support worker and reviewer. Reviewer selects the read-only task contract, not different permissions. Resume preserves recorded settings rather than applying today's defaults.

## Harness setup and limits

- [Claude](claude-code.md): trust, roles, hooks, and model switching.
- [Codex](codex.md): folder access, model selection, and capacity handling.
- [Gemini](agy.md): account setup, headless behavior, and native conversation continuity.
- [Kimi](kimi.md): configured aliases, trust, and resume.
- [Mistral and DeepSeek](vibe.md): per-session model definitions, thinking, subscription access, and cleanup.
- [DeepSeek API backup](pi.md): CC-Switch setup, RPC controls, session locking, and native takeover.

## Startup timing

Measured 2026-11-06 on one macOS machine with ahelpa 0.11.0, using each name's default role and model. The task only asked the helper to write `ok` into `summary.md`. Each name ran 3 times, one helper at a time; the table shows the median and the range. All times are seconds from the start of `ahelpa launch`.

| Name | Default model / effort | `launch` returned | Helper wrote `summary.md` | `wait` returned |
| --- | --- | --- | --- | --- |
| `claude` | `claude-opus-5-5` / `xhigh` (advisor) | 4.4 (4.4–4.4) | 7.8 (7.7–8.4) | 11.0 (10.5–11.3) |
| `codex` | `gpt-6-astra` / `medium` | 5.0 (4.9–5.0) | 12.9 (11.4–15.0) | 19.6 (15.2–20.3) |
| `gemini` | `gemini-4-argon` / `medium` | 4.1 (3.9–5.1) | 21.2 (19.7–22.2) | 30.5 (30.2–30.9) |
| `kimi` | native | 2.9 (2.9–2.9) | 14.6 (14.0–18.4) | 20.5 (19.7–24.6) |
| `mistral` | `mistral-large-4-0-3` / `high` | 4.9 (4.4–4.9) | 13.6 (11.4–16.5) | 20.4 (20.2–24.8) |
| `deepseek` | `deepseek-v4-1-flash-1017` / `high` | 4.4 (4.4–5.0) | 7.7 (7.5–12.6) | 10.6 (9.9–14.9) |
| `deepseek-pi` | `cc-switch-deep-seek/deepseek-flash` / `high` | 0.8 (0.8–0.8) | 4.1 (3.3–4.3) | 10.0 (9.9–26.5) |

- **`launch` returned:** the helper is up and has confirmed the task.
- **Helper wrote `summary.md`:** about when the model finished the work.
- **`wait` returned:** also includes the model's closing message, process exit, and the daemon noticing completion. The daemon polls every 3 seconds, so these values cluster near multiples of 3–5 seconds.
- Real tasks add their own work on top of these numbers. A file-reading task on `deepseek` took about 20 seconds end to end.
- Read the table as orders of magnitude, not guarantees. Network and provider load move every column.
- A helper that has not returned from `wait` within a minute of a trivial task is slower than usual, not necessarily hung. Check `check` before you kill it.

## Compatibility

New session prefixes are `claude-`, `codex-`, `gemini-`, `kimi-`, `mistral-`, `deepseek-`, and `deepseek-pi-`. Nicknames use the corresponding public prefix. Resume preserves the original prefix, including historical `agy-`, `vibe-`, and `pi-` records. An ID without the standard 12-hex suffix resumes with the stored harness's first public prefix, so a non-standard `vibe` record becomes `mistral-`. Names are launch pointers; the stored harness ID remains stable.

The removed `dsh` harness cannot accept new work or resume. Its records remain inspectable and cleanable, and `kill` can reclaim its tmux sessions. See the [candidate registry](../../docs/backends.md#candidate-registry) for the removal decision.
