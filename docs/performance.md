# Performance

How fast a helper starts, and how quickly ahelpa notices that it finished. The numbers come from one macOS machine and move with network and provider load. Use them as reference values, not guarantees.

## What is measured

For each launch, times are seconds from the start of `ahelpa launch`:

| Column | Meaning |
| --- | --- |
| `launch` returned | The helper is up and has confirmed the task. This is the startup time. |
| Wrote the result | When `summary.md` was written, roughly when the model finished the work. |
| `wait` returned | Adds the model's closing message and process exit, and the daemon noticing completion. |

Between "wrote the result" and "`wait` returned", two things happen. First, the model writes its closing message and exits; that part belongs to the harness. Second, the daemon notices completion at its next poll; that part belongs to ahelpa. The daemon polls every 3 seconds, so `wait` returns cluster at multiples of the daemon's poll period. That spacing is how the poll period is measured below.

## Baselines

Set 2026-11-06.

- **Startup reference: 4.5 s** for `launch` to return. A name that stays above **6 s** may have regressed and is worth investigating. Some names start faster by design (`deepseek-pi`, `kimi`).
- **Daemon poll period: about 3 s**, measured by how `wait` returns cluster. A finished helper is then noticed at most one poll after it exits. The poll period must not grow with session history.

## How to measure

```bash
bash scripts/startup-bench.sh --project /path/to/trusted/repo
```

- Every public name is launched with its default role and model. The task is trivial: write `ok` into `summary.md`.
- Helpers run one at a time. Each round starts with a different name. The default is 3 rounds.
- Results go to a CSV (`--out`, default `startup-bench.csv`), and the script prints medians.
- To measure only some names, pass them as arguments, for example `bash scripts/startup-bench.sh deepseek deepseek-pi`.
- The script makes real model calls.
- Use a project the helpers already trust. Claude refuses an untrusted folder.
- A full run takes about 10 minutes.

## Latest results (2026-11-07)

Median seconds over 3 runs, with each name's default model. The trivial task is the one above. `gemini`, `mistral`, `deepseek` and `deepseek-pi` were measured on v0.12.0, after they moved to their own TUIs; `claude`, `codex` and `kimi` come from the earlier run that day, after the poll fix.

| Name | `launch` returned | Wrote the result | `wait` returned |
| --- | --- | --- | --- |
| `claude` | 4.3 | 8.4 | 12.3 |
| `codex` | 5.0 | 11.8 | 15.3 |
| `gemini` | 2.4 | 16.6 | 40.8 |
| `kimi` | 2.9 | 10.3 | 15.3 |
| `mistral` | 4.5 | 7.2 | 15.3 |
| `deepseek` | 4.4 | 10.7 | 15.4 |
| `deepseek-pi` | 1.9 | 5.3 | 9.3 |

All runs succeeded. The `wait` returns cluster at multiples of the daemon's poll period of about 3 s. The gap between writing the result and `wait` is mostly the model's closing turn, not ahelpa. `gemini` varied most (`wait` 24.5–51.8 s): after editing `summary.md` it kept thinking (one archived screen shows "Thought for 7.5s" before `[AHELPA:DONE]`), with no completion nudge involved.

## `deepseek` against `deepseek-pi`

| | `deepseek` (Vibe, Mistral subscription) | `deepseek-pi` (Pi, DeepSeek API) |
| --- | --- | --- |
| Startup (`launch` returned) | 4.4–4.9 s | 0.8–1.9 s |
| Trivial task (`wait` returned) | 10.6–15.4 s | 6.3–10.0 s |
| The same adversarial review (same brief, same code snapshot) | 9.1 min | 24.9 min |
| Four bounded real tasks ([case study](case-deepseek-trial-20261106.md)) | 2.6–5.7 min per task | 2.6–8.8 min per task |
| Review findings | Found the unlogged fallback and two smaller issues | Also found a stale-snapshot reconcile and an untested ordering invariant |
| Reliability seen | No provider errors | The DeepSeek API returned 503 "too busy" four times in a row once |

`deepseek-pi` starts faster, but on real work it was slower and sometimes more thorough. Keep `deepseek` as the default and `deepseek-pi` as the API backup. These are single samples per task.

## History

- **2026-11-07: Pi, agy and Vibe moved to their own TUIs (v0.12.0).** Median `launch` / wrote / `wait`, bridge (poll-fix run) → TUI:

  | Name | Bridge | TUI |
  | --- | --- | --- |
  | `gemini` | 3.9 / 16.0 / 24.8 | 2.4 / 16.6 / 40.8 |
  | `mistral` | 4.9 / 13.5 / 21.4 | 4.5 / 7.2 / 15.3 |
  | `deepseek` | 4.9 / 7.4 / 12.3 | 4.4 / 10.7 / 15.4 |
  | `deepseek-pi` | 1.4 / 4.4 / 6.3 | 1.9 / 5.3 / 9.3 |

  `launch` stays under the 4.5 s reference for all four. The `wait` columns follow the models' closing turns; three runs per name are too few to read a trend into them.
- **2026-11-07: poll fix.**
  - **Symptom.** Before the fix, `wait` returns clustered at multiples of about 5 s (10, 15, 20, 25, 30).
  - **Cause.** Every daemon poll probed each non-dead session row with its own `tmux has-session` process. With about 600 settled rows, that took about 2.3 s per poll on top of the 3 s sleep, and it grew with history.
  - **Fix.** The daemon now takes one `tmux list-sessions` snapshot per poll. It probes rows one by one only when the snapshot itself fails. A row whose capture fails is re-probed immediately.
  - **Result.**
    - One refresh over 600 settled rows went from 2293 ms to 11 ms.
    - The poll period went from about 5 s to about 3.06 s, so the worst-case wait for the daemon to notice dropped from about 5 s to about 3 s.
    - The poll period no longer grows with history.
- **2026-11-06: first benchmark, before the fix.** Median `launch` / wrote / `wait`:

  | Name | `launch` | Wrote | `wait` |
  | --- | --- | --- | --- |
  | `claude` | 4.4 | 7.8 | 11.0 |
  | `codex` | 5.0 | 12.9 | 19.6 |
  | `gemini` | 4.1 | 21.2 | 30.5 |
  | `kimi` | 2.9 | 14.6 | 20.5 |
  | `mistral` | 4.9 | 13.6 | 20.4 |
  | `deepseek` | 4.4 | 7.7 | 10.6 |
  | `deepseek-pi` | 0.8 | 4.1 | 10.0 |
