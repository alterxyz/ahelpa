# Case study: helper output overwhelmed backups (2026-10)

## Conclusion in one sentence

The missing category was a temporary workspace: helpers followed their handoff contract, the project preserved working evidence, and the backup engine enforced fidelity, but together those reasonable rules turned temporary copies into a lasting enumeration burden.

This account uses the incident brief's fixed snapshots without recounting the source trees. References are abbreviated below. `[T]` is the incident brief. `[A]` is ahelpa commit `415ac92`. `[P]` is the project's `dify/ahelpa-evidence-split-20261024/README.md`. `[U]` is `.ahelpa/codex-1ec6959052c9/summary.md` and its `artifacts/rescue-candidates.tsv`. `[B]` is Regent-of-Folders' `journal/2026-10-24-capture-selection-reuse.md`. References into the other projects identify the source material; they are not files in this public repository.

## Why each party's rules made sense

**ahelpa** required reviewers to perform temporary mutation tests while prohibiting writes outside their result directory. Preserving test evidence and protecting the reviewed code were reasonable requirements. However, the old `buildContractSection` in `src/file-handoff.ts` supplied no separate place for working copies. In practice, `artifacts/` became that place. A helper could satisfy the contract while leaving a large working tree beside its report. [A]

**The project** used Git as a work record and whole-machine backups for loss protection. Its `.gitignore`, beginning at line 168, documented the decision to admit session output because it recorded work, had traceability value, and had been checked for credentials. That credential assessment described the files present at the time. Browser cache exclusions were added later. A nearby statement about having no remote and Git being the only backup concerned a separate private notes directory. It was not the justification for admitting `.ahelpa/`. [T; project `.gitignore:168–182`]

**The backup engine** followed a full-fidelity contract. The project's backup board assigned `.ahelpa/*` to pack rules, making each session directory an archive. Capture inventories had to agree before and after capture. Even an ordinary Git commit adding `.git/objects` could invalidate a round. Rejecting an inconsistent capture was correct; marking it successful would undermine the backup promise. [T, B]

## How the rules combined into failure

The requirement for at least three temporary mutations created a need for working copies. Those copies, pytest temporary directories, and uv caches went into artifacts. The project then treated that location as evidence to version and back up. The largest session reached 81,643 reported entries. The largest eight accounted for roughly 400,000. The largest three originated in one overnight batch of mutation-testing helpers. [T, P]

The old selector, `materializeRoot`, ran six rclone lanes per root: `all`, `directories`, `normalFiles`, `withoutPack`, `withoutIgnore`, and `ensured`. The first two carried no user rules. Pack and ignore ownership were calculated afterward using set differences. Packing changed storage representation, but did not bypass enumeration inside the pack. Ignore rules likewise could not eliminate the unfiltered traversal. [B; engine `tools/internal/rcloneselect/materialize.go`]

A complete capture materialized selections repeatedly. A synthetic run recorded 54 rclone calls. A longer inventory window both consumed the time budget and increased exposure to ordinary commits adding objects. Failure could therefore mean a timeout or a correctly rejected changed source; not every failed round had the same cause. Removing files from Git's index did not remove their directory entries from disk, so that action alone could not restore backups. [P, B]

## Timeline

| Date | Event |
| --- | --- |
| 2026-07-30 | The project admitted `.ahelpa/` to Git for process traceability. |
| 2026-10-08 | An overnight batch produced the three mutation-testing sessions that later ranked largest. |
| 2026-10-12 | The last successful state was recorded. |
| No later than 2026-10-15 | The brief places the start of repeated timeouts by this date. |
| 2026-10-24 | ahelpa separated scratch; the project untracked selected residue; the engine committed selection reuse. |
| By 2026-10-25 | The brief's snapshot recorded 155 consecutive failures and no new state. |

Sources: [T, P, B]. Dates follow the source records. Observations made at different times are not presented as one simultaneous measurement.

## Repairs made

**ahelpa: `415ac92`.** `RuntimeLayout.scratchDir` in `src/runtime-layout.ts` provides `/tmp/ahelpa/scratch/<id>/` outside the repository. `src/commands/launch.ts` creates it on launch and resume, exporting `AHELPA_SCRATCH` and `TMPDIR` to the helper process. The revised contract permits reviewers to write there. Copies, temporary work, and caches belong in scratch; artifacts retain patches, logs, and reports. `src/evidence.ts` adds `artifactsEntries` to the evidence returned through `wait`. The count makes unusually large output visible; it is not an automatic violation threshold. [A]

**The project.** It used a classification inventory to remove selected residue from tracking and generate exact ignore rules, leaving the files on disk. Dispatch policy and the handoff template now require scratch outside the repository. [P] identifies `dify/ahelpa-evidence-split-20261024/gen_residue_ignore.py` as the implementation, and `hop/dispatch-policy-v0_1.md` plus `reference/handback-closing-report-template.md` as the policy locations. These locations are reported by the allowed source document. The supplied materials did not provide a commit hash for the project's changes.

**The backup engine: code `5b8ca5d`, record `d38402a`.** `tools/internal/rcloneselect/materialize.go` merges the directory lane into the all-entries lane. `tools/internal/fidelity/capture_plan.go`, `tools/internal/hyper/capture_inventory.go`, and `capture_stream.go` reuse the observed selection. A stable path set needs one materialization per round. A newly encountered path still triggers fresh enumeration, so “once” is conditional on the source remaining suitable for reuse. Inventory consistency comparison is unchanged. This repair has not been installed in the running instance, and backup recovery remains unverified. [B]

## Numbers and measurement boundaries

| Measure | Fixed snapshot or recorded result | Source |
| --- | --- | --- |
| Repository background | 2,570 commits; no remote | T |
| Tree and sessions | Whole tree: 823,526 entries; `.ahelpa/`: 664,364 reported entries, 3.5 GB, 783 sessions | T |
| Concentration | Largest eight: about 400,000; largest three from 10-08; largest session: 81,643 | T, P |
| Common immediate artifact directory names | before, mutations, snapshot, runtime, baseline, tmp, uv-cache, candidate, test-runtime, mutation-copy, __pycache__ | T |
| Git tracking | 114,825 paths, including 112,733 under artifacts; 70,687 untracked, leaving 44,138; disk files retained | T, P |
| Packed history | `.ahelpa`: 133 MiB out of a 3.36 GiB repository, about 3.9% | T |
| Summary sample | Key conclusions from 43 of 46 summaries had been restated in project documents | U |
| Artifact sample | Of 66 artifacts, 19 were not reproducible and 24 remained uncertain | U |
| Dependencies and duplicates | 24 hard-coded reads across 21 historical scripts; 14,520 artifact paths had identical-content copies elsewhere in the repository | U |
| Rescue inventory | 30 rows requiring rescue or migration checks, not a deletion authorization | T, U |
| Document references | 82,247 path references across 1,850 files | P, U |
| History references | Among the latest 300 commits, 230 hashes were cited 3,054 times | T |
| Capture baseline | 54 rclone calls: 24 source and 30 projection; a 182,000-entry fixture took 517 seconds | B |
| Source listing groups | Four groups, about 40 seconds each in the brief; about 45 seconds in the engine record | T, B |
| Failure window | 2,400-second budget; 155 consecutive failures; last success on 10-12 | T |
| Engine repair | Synthetic calls fell from 54 to 15; large-fixture elapsed time fell from 517 to 493 seconds | B |
| ahelpa validation | Closure gate: 1,717 tests; three real helper sessions put node compilation caches in scratch | T |
| New-session observation | Three Codex result directories contained 12–21 entries each | T |

[P] explains that 664,364 came from `find | wc -l`. Newline-containing filenames inflated that count by 1,700; the same snapshot's NUL-safe count was 662,664. The table preserves the reported number rather than relabeling it as an exact entry count. [B] subsequently recorded 156 consecutive failures. This account retains the brief's 155-failure snapshot. Neither changing counters nor samples should be mistaken for a full, simultaneous census.

## Rules that generalize

For ahelpa users:

- Put copies, build intermediates, and caches in `AHELPA_SCRATCH`, so ordinary tool output does not automatically become a permanent deliverable.
- Keep mutation patches, test output, and conclusions in artifacts, so another reader can inspect the evidence without retaining a whole working tree.
- Inspect both `artifactsEntries` and the contents during handoff, because a high count is an investigation signal rather than proof of a contract violation.
- Migrate evidence, script inputs, and references before ignoring old sessions, because a restated conclusion does not make its original record dispensable.

For any combination of handoff directories, version control, and backup:

- Define separate locations and lifetimes for workspace, evidence, and runtime state, because one directory name cannot express all their retention responsibilities.
- Measure indexed content, on-disk entries, and backup enumeration separately, because different rules govern each of those quantities.
- Place temporary work outside every relevant backup root, because moving it out of one repository can still leave it inside an ancestor's enumeration scope.
- Prefer reuse of observations within a round while retaining change detection, because reducing duplicate scans does not require weakening consistency.

## Unfixed, unverified, and disputed

The old directories have not yet been moved out, and migration of unique evidence and script dependencies is incomplete. The brief's broad judgment that more than nine tenths consists of copies and caches does not prove that each item is disposable. The sample cannot establish that for the entire tree. A rescue inventory must be resolved before applying a whole-directory ignore decision. [T, P, U]

History rewriting was not pursued. The historical packed footprint is a small share of the repository, while documents depend on commit hashes. Rewriting history would not remove the live entries that drive enumeration cost. The project's classification also uses path and reference heuristics; it did not establish reproducibility item by item. Those limits matter when deciding what to migrate or retain. [T, P]

The small new ahelpa sessions are an early observation, not a long-term guarantee. This writing task did not rerun the closure gate. The engine's lower synthetic call count does not imply a proportional reduction in elapsed time, and it does not demonstrate production recovery. Packing, filesystem walks, and concurrent writes may still dominate. A successful state after installation is needed before the incident can be called resolved. [T, B]
