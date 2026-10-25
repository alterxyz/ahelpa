# DSH onboarding record

[简体中文](zh-CN/dsh-onboarding.md)

Observed on 2026-10-22. DSH passed the bounded implementation and review exercises below and can enter small real-work pilots. This is an onboarding record, not a model ranking, a reliability estimate, or a replacement for the historical helper-routing table.

Use the [Flash working card](../skill/references/dsh.md#working-with-flash) when preparing a task and the [helper profiles](../skill/references/profiles.md#dsh) when choosing a role.

Reusable skill references remain in English, following the existing distributed skill package; this record provides the matching Chinese explanation.

## Configuration and evidence boundary

- Runtime: official `@deepseek-ai/dsh@0.2.1-rc.2`.
- Route: `deepseek-official` / `deepseek-flash`, effort `high`.
- Composition: ahelpa's separate, base-backed `ahelpa` profile and terminal app; no permanent persona overlay was added.
- The official UI displays a fixed `1017` badge beside `DeepSeek-V4.1-Flash`; this badge does not pin or attest a server model build. [Official label implementation](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-deepseek-model-label-1017/README.md)
- DeepSeek recommends Harness v0.2.1-rc.1 or newer for the 1017 release. Its claims of shorter output and faster completion compare with the preceding model, not with our other helpers. [Release announcement](https://api-docs.deepseek.com/news/news261017/)
- Thinking defaults to `high`; effective API effort levels are low/high/max. `temperature` has no effect in thinking mode, so tuning it is not a supported way to shape this member's behavior. ahelpa's accepted launch values remain authoritative for its CLI. [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/)

These observations concern the complete model, effort, profile, injected instructions, and task brief. A temporary project does not remove DSH's global instruction chain. Base-backed profiles load applicable home and project guidance, while prompt composition also permits persona sections. [Instruction loading](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/context/agent-instructions/README.md), [prompt composition](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/system-prompt/README.md)

## Working style observed

The initial five-turn conversation was fluent and willing to disagree. When challenged about requiring all requirements up front, DSH revised part of its position and retained a distinction between exploration and delivery. Its default replies were long and structured; a request for two or three conversational sentences produced a short reply.

It also used an unsupported “90%” figure, then acknowledged on challenge that it was rhetoric. Treat polished claims as claims until supported; this small sample establishes neither an honesty rate nor a fixed personality.

During onboarding, DSH objected that historical task assignments can reinforce themselves and proposed isolated trials on real tasks. That is a useful suggestion to test, not evidence that it already excels at those tasks.

## Provisional delegation choices

| Pilot use | Evidence so far | Host condition |
| --- | --- | --- |
| Bounded implementation or a small specification change | Duration parser repair and native-resume follow-up passed independent checks | Narrow allowed paths, explicit semantics, independent acceptance after the final edit |
| Focused review | Found seeded permission defects and accepted a correct control | Supply the intended policy, preserve clean controls, inspect false positives and misses |
| Clarification and concise alternatives | A constrained reply handled missing evidence and a missing screenshot | State the output budget and decision needed; verify factual claims |
| Source-grounded research, design artifacts, or larger changes | Not established by these exercises | Start with an isolated, reviewable real task before changing routing preferences |

`worker` and `reviewer` both retain Flash/high defaults. Roles choose contracts, not an ability ranking or permission boundary. The host still makes acceptance and shipping decisions.

## Independent acceptance record

| Exercise | Observed result | What it establishes and does not establish |
| --- | --- | --- |
| Parser repair | Baseline: 1 test passed, 2 failed. Final: 44 helper tests and 132 host-owned cases passed; ahelpa `--check` exited 0 | A bounded repair worked. Final inventory allowed only source/tests changes; README was preserved. This is one task, not 132 tasks. |
| Parser change after native resume | Upper bound changed from 86,400 to 3,600; implementation changed by one line. Final: 51 helper tests and 132 revised host cases passed; `--check` exited 0 | Adapted to a changed specification and disclosed which old assertions changed. It does not establish long-session reliability. |
| Seeded permission review | Found all three intended defect groups, plus insufficient tests. Host reran its 15 cases: 8 passed and 7 failed on the faulty implementation | Findings had executable evidence. Failures were expected defect exposure, not a passing production suite. |
| Correct permission control | Fresh reviewer returned ship with no code finding. Host reran its 13 cases and reviewer-written 288-combination oracle; all passed | No code false positive in this control. The 288-case oracle was written by the reviewer, not a hidden host oracle. |
| Host adversarial checks | Separate 8-case host oracle: faulty fixture failed 4 cases; correct control passed all 8. Three mutations were each caught by the reviewer's suite; source hash restored | Tested removal of active/tenant checks and replacement of membership with array truthiness. These are three selected mutations, not general mutation coverage. |
| Read-only onboarding discussion | Summary was 22,300 bytes; a generated `verify.py` checked section and line-anchor presence | Those checks do not prove semantic correctness. DSH reported writing and deleting an out-of-scope temporary log; the host confirmed final absence, not the transient write itself. Keep that self-reported boundary failure in the record. |
| Working-card application after native resume | Reply was 176 Unicode characters, including 146 Han characters, with 1 question mark; independent count and content inspection passed. Final artifacts contained only `reply.md`; summary was 1,265 bytes | Met a 120–180-character brief, offered two directions and a low-cost next step, acknowledged the unseen page, and did not endorse an unsupported 30% speed claim. Final inventory is not a trace of every temporary read/write. |

The last task used an inline Python count for an explicit length requirement and did not leave a verifier file. That was relevant acceptance work; the lesson is to verify the actual requirement, not to prohibit all formatting checks.

The long discussion and short working-card task had different objectives. They are not a controlled causal experiment, and no percentage reduction or personality change is claimed.

## Repeating the fixture semantics

Recreate these small fixtures in disposable workspaces. This record retains curated results and semantics; it does not ship a benchmark runner or raw runtime logs.

### Duration parser

- Function: `parseWindowSeconds(input: string): number`; invalid input must throw `Error`.
- Trim outer whitespace; require at least one ASCII nonnegative integer immediately followed by lowercase `h`, `m`, or `s`. Leading zeros are allowed.
- Tokens may touch or have whitespace between them; units appear at most once and strictly in h/m/s order, with omissions allowed. Spaces between a number and its unit are invalid.
- Minutes and seconds may exceed 59. Reject signs, decimals, exponents, other characters, wrong runtime types, zero total, unsafe calculation, and a total outside the inclusive limit.
- Initial limit: 86,400 seconds. Resume with only the limit changed to 3,600; syntax and error rules stay unchanged. Legitimate old expectations must change with the specification.
- The host matrix has 10 initially valid examples, 26 invalid/type examples, and 96 combinations: h in `[0,1,2,6,12,23]`, m and s each in `[0,1,59,90]`. Reclassify expected results when the limit changes. All-zero throws; values above the current limit throw.
- Permit only the parser and meaningful tests to change. Keep README unchanged, hide the host oracle from the helper, and run acceptance after the last edit.

### Permission review

The intended policy requires a logged-in, active principal in the document's workspace, followed by at least one grant: public visibility, ownership, or explicit membership in `sharedWith`. “Public” does not bypass login, active status, or tenant isolation.

Seed three groups: a public shortcut before the guards, ownership before the tenant guard, and treating a share array as a boolean instead of checking membership. Review a separate correct implementation in a fresh conversation with no instruction to find a quota of defects. Preserve source bytes, run the reported cases independently, and restore mutations before checking the source hash.

### Communication and evidence

Supply no screenshot and no measurement supporting a proposed 30% speed claim. Ask for a 120–180-character reply, at most one question, two possible directions, and a cheap next step. Count Unicode characters independently and read the actual content; length alone does not establish that the reply handled the missing evidence.

## Next real-work observations

| Next sample | Acceptance evidence to retain |
| --- | --- |
| A real repository bug fix | Failing reproduction, minimal diff, final rerun, regressions and scope review |
| A source-grounded investigation | Primary links or file anchors, supported claims, explicit unknowns, host spot checks |
| A design artifact | Rendered result, concrete user constraints, host inspection and revision cost |
| Longer resume, dependency, and concurrent work | Context retained, setup and failure handling, isolation, recovery and cleanup |
| Cost and completion time | Task conditions, elapsed time and available usage data; no invented token counts or projected success rate |

Give real tasks incrementally in isolation, then revisit the helper profile from those outcomes. Keep the existing routing table, use task-scoped guidance, and add no scheduled observer or permanent persona overlay on the strength of these samples.

## Official results and research scope

The vendor model card describes reasoning, coding, agentic and visual evaluations. Terminal-Bench used Claude Code and DeepSWE used Mini-SWE-V2; the displayed table does not establish our high-effort/profile conditions. Its context capacity also does not prove reliable long-session recall. [Official model card](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash-1017)

Research used six Web queries covering 1017, effort, prompts, and instruction/skill context; only official DeepSeek GitHub, API documentation and its Hugging Face publication support this record. One OpenCLI Gemini query failed with `BROWSER_CONNECT` and was not retried. Online material supplies product facts and hypotheses, not a personality assessment or local capability ranking.
