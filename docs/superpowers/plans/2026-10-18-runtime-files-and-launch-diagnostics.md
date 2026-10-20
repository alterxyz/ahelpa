# Runtime Files and Launch Diagnostics — open work

> **For the next session:** nothing here is implemented. Every item waits for the author's go-ahead. Installing a new binary changes the runtime for every live helper on the machine, so agree the install window with whoever is running helpers before you deploy.

**Question that started this (2026-10-11):** the author asked how to handle the possibly temporary files that ahelpa produces. The short answer: they are not one kind of file. They fall into tiers with different lifetimes, and today nothing separates those tiers.

## What one machine showed (2026-10-11, rechecked 2026-10-18)

- **Records**: `~/.ahelpa/state.db`, `archive/` (about 1,000 sessions) and `need-help.jsonl` take less than 10 MB together. The 2026-10-07 archive analysis behind v0.9.0 was built from them, so keep them.
- **`~/.ahelpa/daemon.log`** grew to 1.4 GB (16.4 M lines). Almost all of it came from one storm of about 52 minutes on 2026-10-09: `refresh failed` and `recovery failed: No such file or directory`, about 8.2 M lines each. During that hour each session was refreshed about 27,000 times, far more than the 3 s daemon loop explains. Concurrent inline refreshes are the likely source. The root cause has not been diagnosed. Someone later deleted those lines by hand (360 KB on 2026-10-18), but nothing stops it from happening again. The catch in `refreshSessionStatuses` (`src/daemon.ts`) logs every failure, with no dedupe and no backoff.
- **Deploy backups** in `~/.ahelpa/backups/` were 465 MB on 10-11 and 574 MB on 10-18, plus copies at `bin/ahelpa.backup.*`. Nothing ever prunes them.
- **`/tmp/ahelpa`** is 408 KB and already reclaimed. No action needed.
- **Project `.ahelpa/` directories**: the worst ones held 120k–167k files, mostly helper scratch. For example, one session's `artifacts/benchmark/tmp` alone held 101k files; others held a `uv-cache` and nested `.git` clones. The harm comes from the file count, not the bytes: a backup tool's per-file fingerprint pass stalled on one of these directories. In a long-running host project, 97% of the bytes sat in directories that the host's records cite, so it is evidence, not trash.
- **`git worktree remove` deletes evidence (verified).** Even without `--force` it exits 0 and deletes a gitignored `.ahelpa/` along with the worktree. With `--worktree`, the helper's `summary.md` and `artifacts/` live inside that worktree, so removing it silently destroys the evidence and breaks `--after` chains. At least one host project lost cited artifacts this way.
- **A failed launch leaves nothing behind.** On 2026-10-14 two Codex launches failed with "did not reach its input prompt". Someone recorded the diagnosis "the prompt glyph changed to `»`", and it was later withdrawn: codex-cli 0.162.1 draws U+203A `›` (bytes `e2 80 ba`), and Codex launches succeeded one to two hours later. The real cause is unknown, because the launch catch block in `src/commands/launch.ts` kills the tmux session and removes the handoff dir before anyone can see the screen.

## Tiers

| Tier | Contents | Owner | Handling |
| --- | --- | --- | --- |
| Runtime | FIFOs, the `/tmp` task file, pid file | ahelpa | Already reclaimed at settle |
| Records | `state.db`, `archive/`, `need-help.jsonl`, `task.md`, `summary.md` | ahelpa | Keep, with no expiry |
| Ops files | `daemon.log`, deploy backups | ahelpa | Bound them (items 2 and 5) |
| Scratch | caches, temp files, clones, intermediate runs | currently nobody | Write outside the project (item 4) |
| Evidence | the parts of `artifacts/` that the host reads or cites | the host | ahelpa never touches it |

Principle: ahelpa never deletes anything inside a project automatically, because it cannot know what the host's records cite. "Not cited yet" does not mean "disposable" either: a host's in-flight install and rollback directories are uncited on the day they are made. ahelpa should route scratch out of the project and keep its own files under `~/.ahelpa` bounded.

## Open work (in priority order)

- [ ] **1. `--worktree` keeps evidence in the source repo.** Plan the delivery dir as `<source>/.ahelpa/<id>/` (an absolute path in the task) instead of a dir inside the worktree. This item comes first because its loss is irreversible. Acceptance: a test launches with `--worktree`, writes `summary.md` and an artifact, runs `git worktree remove` (without `--force`), and both files still exist under the source repo's `.ahelpa/<id>/`; `wait` evidence and `--after` point at the same paths.
- [ ] **2. Bound `daemon.log`.** Rotate it by size (for example 10 MB × 3 files). When a session repeats the same error, log it once and add a count. Back off on a session whose refresh keeps failing. Then diagnose the 2026-10-09 ENOENT storm: find which file was missing and who was refreshing at that rate. Acceptance: a test makes one session fail refresh 10,000 times and the log stays under the size cap with one line plus a count for that error; other sessions keep refreshing; rotated files never exceed the configured total.
- [ ] **3. Keep the screen of a failed launch.** On "did not reach its input prompt", and on any other `prepareForTask` failure, save the last pane capture before killing tmux (for example `~/.ahelpa/launch-failures/<id>.txt`) and print that path in the error. This is a small change, and without it the next launch failure will be undiagnosable again. Acceptance: a driver test whose fake pane never shows an input prompt makes `launch` fail, and the error names a file that holds the last capture; tmux, the reservation and the temp task file are still cleaned up as today.
- [ ] **4. Scratch outside the project.** Give each session a scratch dir outside the project (for example `~/.ahelpa/scratch/<id>/`) and name it in the task contract: `artifacts/` holds only evidence the host will read; caches, temp files, clones and intermediate runs go to scratch. `clean` reclaims the scratch of the records it removes. Acceptance: the task file names the scratch path; a test shows `clean` removes scratch only for records it removes and never touches the project's `.ahelpa/`; after a week of real use, new project `.ahelpa/<id>/` dirs hold hundreds of files, not tens of thousands.
- [ ] **5. Prune deploy backups.** Keep only the newest two in `~/.ahelpa/backups/` and in `bin/`. Acceptance: after three consecutive deploys, exactly two backups remain, the newest of which matches the binary that was replaced last.

Not planned: an expiry for records or archives; any automatic pruning of project `.ahelpa/` dirs.
