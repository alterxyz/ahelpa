# Helper 后端：接什么、怎么判断、怎么接

[English](../backends.md) | [简体中文](backends.md)

本页回答三个问题：什么样的 agent 适合接成 ahelpa 的 helper（**接什么**），怎么判断（**怎么判断**），大致怎么接（**怎么接**）。末尾附一份「已评估候选」登记表。写于 2026-11-06，对应 ahelpa 0.10.0。

研究或提议一个新后端之前：

1. 先在[登记表](#候选登记表)里查这个候选。有评估卡就先读卡；几周内的结论通常仍然有效。
2. 读它的任何代码之前，先做[漏斗第 2 步](#准入漏斗)的五分钟检查。起决定作用的事实（个人账号还能不能登录）很便宜就能查到，查晚了代价很高。
3. 无论接不接，结论都要记进登记表。

本页的原则要长期有效。[`docs/backends/`](../backends/) 下的候选评估卡是带日期的证据记录，只写英文，会过期。

## 定位

ahelpa 是让一个 host agent 把活交给另一个 agent 的 CLI。三个特征：

- **持久。** helper 是一个 tmux session 加一行 SQLite 记录。它比调用方活得久，之后任何进程都能用 `wait`、`check`、`send`、`resume` 接着管。
- **本地。** 没有服务器、没有账号、没有网络服务。状态在本机的 SQLite、tmux 和命名管道里（见[架构](architecture.md)）。
- **文件交接。** 任务以文件交给 helper；结果以 `summary.md` 加 `artifacts/` 返回；一行暗号（`[AHELPA:DONE]` / `[AHELPA:NEED_HELP]`）宣告回合结束。host agent 始终是指挥者，凭 ahelpa 收集的证据决定是否交付。

它服务 agent 之间三种关系里的两种：*subagent*（启动、等待、拿一份报告）和 *teammate*（持久、可寻址，在同一个 job 内有受限的 peer mail）。*colleague*（不是本 job 里任何人启动的会话）能在 `status` 里看到，但永远不可控；它说的话是供权衡的信息，不是指令。

ahelpa **不是**：

- 编排器或工作流引擎（编排由 host LLM 负责，见[拒绝过的设计](#拒绝过的设计)）；
- 模型网关（driver 只传 `--model`；provider 和密钥仍在上游 CLI 自己的配置里）；
- 沙箱（`--safe` 是上游有低权限姿态时的低权限姿态，不是安全边界，见[安全说明](security.md)）；
- 带共享记录的聊天工作区，也不是 MCP server。

依据：`README.md`、`docs/architecture.md`、`CONTEXT.md`，以及设计提案 `git show b87fe45:docs/proposals/2026-10-08-orchestration-lessons-clawwork-confer.md`（§6 拒绝的设计，§9 定位）。

## 先分类

多数候选在这一步就结束了。先把候选放进下面恰好一行，再做别的。只有第一行会产生 driver。

| 层 | 是什么 | 结论 | 例子 |
| --- | --- | --- | --- |
| **helper 后端** | 本身就是干活的 agent harness：读文件、改文件、跑命令、调模型。 | driver 候选，进入漏斗。 | `claude-code`、`codex`、`kimi`、`pi`、`agy`、`vibe`、`dsh`；候选 OpenCode |
| **host 目标** | *调用* ahelpa 的 agent，对应 skill 安装目标，不是 driver。同一个 agent 可以两者都是。 | 是 skill 安装问题，不是 driver 问题。 | skill 目标 `codex`、`claude-code`、`kimi-code-cli`（三者同时也是 helper 后端） |
| **模型／网关层** | 位于 driver 之下：provider 端点、路由、密钥代理，或无状态的模型 CLI。 | 是某个现有 driver 的配置，绝不是新 driver。 | Magpie（DSH 的路由）、Kimi `config.toml` 里的 provider、Pi 的 `provider/id` 模型、`gemini-api` |
| **同行运行时** | 和 ahelpa 处在同一层的编排或管理工具。 | **参照，不是拒绝。** 吸取经验，必要时考虑互通，不写 driver。 | Raft、mngr、oar |
| **套壳／桥接** | 别人给某个 agent 做的插件或 bridge。 | 去评估它底下那个 agent，不评估壳。 | `dsh-raft-channel`、`raft-acp-bridge`、mngr 的 `mngr_antigravity` 插件 |

两个问题能解决多数争议。*它自己干活，还是在运行别的干活的 agent？* 后者是同行运行时。*它是否位于某个现有 driver 之下、只提供模型？* 是的话它是网关。

## 准入漏斗

先查便宜的，贵的放后面。遇到第一个不通过的就停，并记录停在哪一步。每条门槛都带一个**因为**，对应 ahelpa 的一个原语，这样架构变了以后，后来的人能判断哪条已经不适用。

### 第 1 步：分类

层不对就停。把正确的层记进登记表。

### 第 2 步：生命周期与资格（五分钟，不读代码）

| 检查 | 因为 |
| --- | --- |
| 上游还在维护吗（最近发布、活跃度、已宣布的停服）？ | driver 要追着一个会变的 TUI 或协议；上游废弃，driver 就是负担。 |
| **你实际要用的账号类型还能认证吗？** 读上游 README 顶部的状态提示和最新公告，搜「individual accounts no longer supported／discontinued」，条件允许就在临时 home 目录里用该账号类型真登一次。 | helper 无人值守地跑在用户自己的订阅上。对着 stub 写出来的代码是对的，也不能证明服务还接受这种账号（某个第三方调度器自己的、由 AI 起草的 issue 称，它第一次真实登录 Gemini CLI 是在个人账号通道关闭四个月之后，并且失败了，因为此前每项检查都对着源码或 stub；这是线索，不是证据，见 [Gemini CLI 卡片](../backends/gemini-cli.md)）。 |
| 条款允许自动驱动厂商的**官方 CLI** 吗？（不是第三方客户端或令牌代理。） | ahelpa 在 tmux 里往真实 CLI 敲键盘；条款若禁止自动化使用，这个集成对每个用户都是隐患。 |
| 支持 macOS 和 Linux（x64、arm64）吗？ | 运行时和安装器恰好支持这些平台。 |

### 第 3 步：硬门槛

每条都是 ahelpa 离不开的原语。任何一条不过，就不做 driver，或等上游改变后再评。

| 门槛 | 因为 |
| --- | --- |
| **进程能活在 tmux 里，或者能被桥接进去。** | session 就是 tmux session；daemon 抓它的 pane，`send-keys` 投递输入，`tmux attach` 是人的后门。 |
| **一个会话里能多轮，或者有原生恢复。** | `send`/`task` 把追问送进活着的 pane，`resume` 靠原生 token 重建已结算的会话。两者都没有，helper 就退化成「每次交付一个进程」，而这已被[拒绝](#拒绝过的设计)。 |
| **无人值守时不必改全局配置**（提案条目 A6）。 | 启动不能改写用户的 CLI 设置之类的文件：爆炸半径会波及他们自己的所有会话。hook、权限、信任必须能靠启动旗标、环境变量或会话级文件设置。必须持久化信任的，是有文档记载的例外（见[安全说明](security.md)），不是默认。 |
| **能读任务文件、写结果目录、打印暗号。** | 文件交接加暗号是唯一的完成约定；ahelpa 优先文件，而不是解析终端输出。 |
| **自更新不会打断运行中的会话。** 要么有开关能关掉，要么可证明只在下次启动时生效，要么 driver 能关掉它的弹窗。 | 会话中途替换二进制或弹出阻塞对话框的更新，会破坏就绪检测并杀死常驻 helper。树内的 driver 用三种不同办法满足这条（见下面的矩阵）；会替换二进制的后台更新器是最坏情形，必须有开关。 |

### 第 4 步：软能力（决定接到哪一档，不决定能不能接）

| 能力 | 因为 |
| --- | --- |
| **结构化的回合结束信号和输入归属**（hook、notify 命令或 RPC 事件）。 | 没有它，daemon 只能靠不活动推断回合结束；归档里 63 个 Claude `needs_attention` 会话有 47 个已经写好 summary 却没打暗号（提案 A6）。 |
| `--model` 和 `--effort` 旗标。 | `launch --model/--effort` 和角色预设靠它们设置。没有就用原生默认值，这是允许的。 |
| 低权限姿态（`--safe`）。 | `--safe` 承诺的是「在支持处」。上游没有低权限姿态的，driver 必须**拒绝**这个旗标（Pi 和 DSH 就是如此），而不是忽略。 |
| 会话级信任。 | 持久信任会在会话之外写状态（Codex 和 Kimi 就是，见[安全说明](security.md)）。会话级信任可避免。 |
| 运行时切模型。 | `ahelpa model` 要靠它驱动运行中的 helper。可选。 |

通过漏斗只回答**能不能**接，不回答**该不该**接。后者由负责人定：它覆盖了现有 driver 覆盖不到的什么需求？比如在 Pi 旁边再接一个同样不绑 provider 的开源 harness，理由不能只是「接得上」。

## 三种接法

下面三种形态来自 `src/drivers/` 的实际代码。按上游提供什么来选。

| 形态 | Driver | 怎么运作 | 什么时候选 | 代价 |
| --- | --- | --- | --- | --- |
| **TUI 抓屏加 hook** | `claude-code`、`codex`、`kimi` | driver 在 tmux 里启动厂商自己的 TUI，用 `send-keys` 输入，从 pane 抓屏读状态。上游接受单次调用 hook 的，driver 注册一个会话级 hook，经隐藏命令 `__turn-hook` 往 `.ahelpa/<id>/turns.log` 追加记录（Claude：`--settings` 文件；Codex：`-c notify=[...]`）。Kimi 没有 hook，靠不活动启发式。 | TUI 稳定、有会话级 hook，并且希望人能 attach 到真实界面。 | 每个对话框都是一个抓屏用例：信任提示、更新菜单、模型选择器、容量中止（`codex.ts` 处理了好几种）。上游界面一变，检测就坏。 |
| **tmux 里的结构化桥接** | `pi`、`agy`、`vibe` | 一个小桥接进程跑在 tmux 里，说上游的结构化模式，对 ahelpa 呈现一个简单的行协议（输入行排队、`/exit`、暗号；Pi 另有 `/abort`）。结算来自结构化事件或子进程退出，不看屏幕。 | 上游是闭源或界面变得快的 TUI，**同时**提供稳定的结构化模式（有回合结算和原生 session id）。优先桥接而不是抓屏。 | 桥接要自己维护：进程树清理、防并发写的锁、对无法回答的审批请求选择拒绝或取消。 |
| **进程内 app** | `dsh` | 上游是没有可用终端界面的框架。driver 生成一个终端 app，经上游的 patch／插件叠加层加载，直接调用它公开的 Agent/Session API，多轮共用一个进程。 | 上游可嵌入、有公开 API，且没有值得抓屏的 TUI。 | 与上游内部耦合最深；固定在一个 release candidate 版本。 |

取舍：有 hook 且 TUI 稳定 → 抓屏加 hook。有结构化模式且 TUI 多变 → 桥接。没有 TUI 但有公开的进程内 API → 进程内 app。具体选哪种，在 [spike](#spike-清单) 里决定，不在之前。

## 最低可接受的 driver

底线是[硬门槛](#第-3-步硬门槛)加上 `AgentDriver`（`src/drivers/types.ts`）的 15 个必选成员：`name`、`sessionPrefix`、`modelCatalog`、`resumeTokenAvailableAfterSubmit`、`buildLaunchCommand`、`buildResumeCommand`、`extractResumeToken`、`prepareForTask`、`prepareForResume`、`afterTaskSubmitted`、`switchModel`、`detectStatus`、`detectOutcome`、`detectActivity`、`gracefulExit`。其余七个（`turnHooks`、`prepareLaunchFiles`、`launchProfiles`、`checkReadiness`、`acceptsInput`、`acceptsInputAfterTurn`、`workingAfterTurn`）是可选的。

这条底线真实存在的证据是 `kimi`：没有回合 hook、没有 `--effort`、不能运行时切模型，照样是正式支持的 driver。Pi 和 DSH 走得更远，直接拒绝 `--safe`。所以要把两个问题分开回答：

- **能不能接？** 看硬门槛。
- **接到哪一档？** 底线（只过门槛）→ 加结构化的回合结束信号 → 再加 model/effort、safe 姿态和运行时切换。缺少软能力只会降档，不会挡住准入。

Vibe 也采用结构化桥接形态，每回合启动一个 headless 子进程；桥接和原生会话持续存在，后续子进程都恢复同一会话。子进程退出即结算回合，不依赖 RPC result 事件。

## Driver 能力矩阵

2026-11-06 据 `src/drivers/*.ts` 和 `skill/references/*.md` 手写。同样的列也是新候选的打分格子：评估卡的「Grid」一节照此填写。

| | `claude-code` | `codex` | `kimi` | `pi` | `dsh`（已退出默认派工） | `agy` | `vibe` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 形态 | TUI + hook | TUI + hook | TUI，无 hook | RPC 桥接 | 进程内 app | stream-json 桥接（同 `pi`） | 每回合 streaming 子进程，持续桥接 |
| 恢复 token（`resumeTokenAvailableAfterSubmit`） | 仅退出后可得（draining 期间捕获） | 仅退出后可得（draining 期间捕获） | 首次提交后立即可得（原生 `session_*` id） | 首次提交后立即可得（原生 UUID） | 首次提交后立即可得 | 首次提交后立即可得（`init` 事件里的会话 UUID，第一条消息之前就有）；agy 不认识的 id，桥接直接让 resume 失败 | 首回合首个事件的 sessionId；`--resume`；未知 id 报错 |
| 回合结束信号 | 经 `--settings` 会话文件的 hook：`UserPromptSubmit`、`Stop`、`StopFailure` | 单次调用的 `-c notify=[...]` 覆盖（`agent-turn-complete`） | 无；不活动启发式加暗号 | RPC 的原生结算事件 | app 内状态标记 | stream-json 每回合一个 `result` 事件（`status`、`finished_reason`） | 子进程退出码 + 助手正文暗号 |
| `--safe` 的含义 | 去掉 `--dangerously-skip-permissions`，原生审批仍在；结果目录在项目外时加 `--add-dir` | `-s workspace-write -a never`（加 `--add-dir`） | 用 `--yolo` 取代 `--auto`（高风险动作仍会询问）；不是沙箱 | 拒绝 | 拒绝 | 拒绝 | 拒绝 |
| 信任是否持久化 | driver 不管；用户须先在项目里跑一次 `claude`，否则启动快速失败 | 是：回答「Folder access」（0.163+）会把仓库根写成受信任，保存在 Codex 配置里；hooks 信任提示用 Escape 暂时拒绝 | 是：两种模式都会选「Trust and continue」，由 Kimi 持久化 | 无信任提示；桥接传 `--approve --no-extensions --no-mcp --offline` | 无信任提示；`DSH_PERMISSION_MODE=danger-full-access` | print 模式无信任提示；不落盘 | `--trust` 仅本次调用，不持久化 |
| 自更新 | driver 未压制（上游行为未在此核实） | 更新对话框用「Skip」跳过；未压制 | `KIMI_CODE_NO_AUTO_UPDATE=1` | driver 未设置（传了 `--offline`，它对更新检查的影响树内无记载） | driver 不控制；遥测用 `DSH_TELEMETRY_DISABLED=1` 关闭 | `AGY_CLI_DISABLE_AUTO_UPDATE=true`（1.5.2 只认小写 `true`；设成 `1` 仍会拉起更新进程） | `VIBE_ENABLE_AUTO_UPDATE=false`, `VIBE_ENABLE_UPDATE_CHECKS=false` |
| 模型／effort | 启动时 `--model`、`--effort`；运行时经模型菜单切换 | `--model`、`-c model_reasoning_effort=`；运行时经模型菜单切换 | 只有 `--model <config.toml 别名>`；无 effort；不能运行时切换 | `--model provider/id`、`--effort`，启动时核实；不能运行时切换 | `--model [provider:]model`、`--effort off\|low\|high\|max`；不能运行时切换 | 默认 `--model gemini-4-argon --effort medium`；带后缀的 id（如 `gemini-4-argon-high`）须配同名 `--effort`；不能运行时切换 | 会话 agent TOML：默认 `mistral-large-4-0-3` / `high`；不能运行时切换 |
| 最后验证的上游版本 | 树内未记录固定版本；`doctor` 报告已安装版本 | 0.163+（Folder access）；容量短语见于 0.154；更新对话框格式 ≤0.15x 与 0.160 | Kimi Code 2.x（`--auto` 需要） | ≥ 1.4.0，测试基线 1.4.0；2026-11-06 见过 1.5.0 | `@deepseek-ai/dsh@0.2.1-rc.2`；2026-10-30 对比中见过 rc.5 | 测试基线 1.5.2（2026-11-06） | 测试基线 3.1.0（2026-11-06） |

ponytail: 手写会和代码漂移；漂移真正造成麻烦时，再改成从 `AgentDriver` 生成。

## Spike 清单

对通过漏斗第 1、2 步的候选，在临时目录和临时 home 里跑一遍。这是 agy 用过的七个问题，抽象成了通用模板。每个答案都要记下命令、上游版本和日期。

> 先注意副作用：运行 agent 二进制可能改变这台机器。agy 的后台更新器，哪怕你只运行 `agy models`，也可能替换已安装的二进制（第三方在 1.1.22 上报告；在 1.5.2 上把开关设成 `1` 仍会拉起更新进程，只有小写 `true` 有效）。优先用 `--help` 和 `--version`，并且在运行其他任何东西之前先设好更新开关。

1. **tmux 里的登录与首次引导。** 登录能在 pane 里完成吗？凭据存在哪（文件还是系统钥匙串；无头用户可能没有钥匙串）？哪种账号类型可用？首次启动会出现哪些画面（主题、提示、信任、遥测同意），每个都有能关掉它的按键吗？
2. **自更新。** 由什么触发（前台检查还是脱离终端的后台更新器），替换什么，怎么关（旗标、环境变量、配置）？能固定版本吗？
3. **恢复 id。** 什么时候生成（启动时、首次提交后、退出时），从哪里读（pane、文件、API），能预先指定吗？恢复能和姿态、模型、effort 旗标组合吗？
4. **skip-permissions 之后还剩哪些提示。** 打开上游的「全部放行」旗标后，还有哪些对话框（目录信任、hooks 信任、MCP 审批、工具专属的「危险」确认、更新、引导），哪些能靠按键回答？
5. **会话级 hook 与设置。** hook、权限、信任能只对一个会话注册（旗标、环境变量、会话级文件）吗？唯一途径若是全局文件，A6 门槛就不过。会话文件和用户自己的配置怎么合并？
6. **暗号经过渲染后还能不能抓到。** 让 agent 通过真实 TUI 打印 `[AHELPA:DONE]`，在窄宽两种终端宽度下用 `tmux capture-pane` 抓：折行、markdown 渲染、面板、颜色码、滚动缓冲。还要看 agent 会不会回显任务文本（被引用的暗号是误报）。
7. **结构化模式。** 非交互或 RPC 模式（`-p`、stream-json、RPC、ACP）能否跨回合保持上下文，能否与 resume 组合，是否上报回合结束事件，无头时如何处理审批请求（默认拒绝吗）？

Spike 的结果决定接法形态和档次，并写进候选的评估卡。

## Spike 之后

1. **实现。** `src/drivers/<name>.ts`、在 `src/drivers/registry.ts` 注册、带合成 pane fixture 的测试，以及所有其他枚举 driver 的地方（见[添加 driver](development.md#添加-driver)）。
2. **Closure gate。** 在 `bun run closure:gate` 里加一个场景。计费型或付费后端只在设置了 `AHELPA_GATE_<NAME>=1` 开关时运行。gate 必须显示 `wait`/`check` 能观察状态、`kill` 能回收 session；driver 支持 resume 的，还要验证原生 resume 和上下文连续性。
3. **入职观察。** 一份带日期的记录，写明跑了什么、证明了什么。[`dsh-onboarding.md`](dsh-onboarding.md) 是现成范例：配置与证据边界、观察到的工作风格、暂定的派工选择、一张说明每个练习**没有**证明什么的验收表。
4. **档案。** 把这个 helper 写进 `skill/references/profiles.md`（擅长什么／要留意什么／怎么给任务／运行时怪癖，外加观察状态）以及一页 `skill/references/<name>.md` 配置说明。默认派工的决定跟着档案走，不要反过来。

### 退役一个后端

退役是文档改动，不是删除。先例是 2026-11-06 的 DSH：2026-10-30 的同条件对比，加上一周真实使用的简短复盘，支持让 Pi 顶替它作为默认派工。改动只涉及文字：`skill/references/profiles.md`（`## dsh`）现在写明该 helper 已从默认派工退役，安装和 driver 保留，点名启动仍然可用，用于对比和回退。删除 driver 是另一个更大的决定。同一天更新登记表那一行。

## 拒绝过的设计

这些决定来自 2026-10-08 的设计提案（ahelpa v0.9.0，§6），至今有效。列在这里是为了能 grep 到。要再次提议之前，先读理由。

| 设计 | 为什么不做 |
| --- | --- |
| **MCP server 接口** | host 本来就能 shell out，用法由 skill 文档驱动；`wait` 能阻塞几分钟，适合 CLI 调用。MCP 接口的代价是每次升级都要在每个 host 上刷新 schema、迁移参数。万一以后真要，就从 `src/command-contract.ts` 生成一个薄包装，绝不另立第二份契约。 |
| **工作流引擎或团队文件运行器** | host LLM 是指挥者，必须仍由它读证据、决定是否交付。只会转述 performer 自述的指挥者不够用：归档里自述与独立复核分歧太多。零运行时的替代方案是任务文件模板。 |
| **满权限作为唯一姿态** | 永远满权限的工具不会被卡住，代价是没有更低的姿态。ahelpa 默认以本地满权限启动（[安全说明](security.md)里直说了），但凡上游有更低姿态就保留 `--safe`；没有的，driver 拒绝这个旗标。 |
| **每次交付一个进程、不持久** | 它去掉了 daemon，代价是丢掉所有在途工作。tmux 加 SQLite 意味着任何一个 ahelpa 进程死掉，在途工作都不会丢。 |
| **共享 transcript 或不设界的 agent 间循环** | 只有 host 转发。`--after` 仍是 host 选定的、指向文件的指针。有界的替代方案是 job 范围、有预算、基于文件的 peer mail，它不授予控制权，也不能改派任务。 |
| **以 ACP 作为传输层** | 四点理由说明这是错误的赌注：(1) 同时驱动九种 agent 的 MCP 工具 Confer，对 Claude 和 Codex 也不依赖 ACP，而是用进程内桥接去连厂商自己的官方接口；(2) Claude Code 和 Codex 没有第一方 ACP，只有它们自己的结构化接口，第三方适配层必然落后于变化快的 CLI；(3) 会丢掉只有 CLI 才有的能力（斜杠命令、模型菜单、审批与信任对话框、插件触发、`tmux attach`）；(4) ACP 是 stdio 会话，持有客户端那一端的进程一死会话就丢，而 ahelpa 的设计正是为了不存在这样的进程。已经拿到大部分价值的增量做法是结构化的回合结束 hook。这并不禁止针对某个上游、基于它自己结构化模式的[桥接](#三种接法)；每个上游按各自的情况判断。 |

## 证据规则

原则长期有效，卡片会过期。两者分开放：原则在本页，带日期的事实在评估卡和登记表里。

- **来源优先级。** (1) 本地二进制：`--help`、`--version`、changelog、内嵌文档，无害时也可看它的字符串。(2) 官方仓库及其 changelog。(3) 官方文档。(4) 第三方文章。网上的「迁移指南」有时包含根本不存在的命令；别人仓库里由 AI 起草的 issue 只是线索，不是证据；这类事实要标明是第三方。
- **每条事实都标日期和版本。** 写 `(2026-11-06, agy 1.5.2, 本地 --help)`，不要写「agy 支持 X」。上游 CLI 每周都在变。
- **未验证就是未验证。** 没查过的写 `Unverified`，并写明试过什么。绝不能用貌似合理的猜测填空。
- **留意检查本身的副作用。** 见 spike 清单上方的提示。
- **写明结论停在哪一步。** 登记表记录漏斗的哪一步，这样后来的人知道哪些事实从未被检验过。

### 卡片格式

评估卡放在 `docs/backends/<name>.md`，只写英文（这是 `AGENTS.md` 中双语规则的例外：它们是带日期、给 agent 用的证据记录，不是用户指南）。每张卡片都要能单独回答：它是什么、归哪一层、卡在漏斗哪一步、结论、何时值得重新评估。小节顺序：头部各行（Evaluated、Class、Verdict、Stopped at、Version seen、Re-evaluate when）、What it is、Facts（带日期和来源）、Grid（矩阵里的各列）、Unverified、Why this verdict、History。重新评估时就地更新卡片、追加一行 History，并更新登记表那一行。

## 候选登记表

2026-11-06 更新。「停在」指候选被检验到的最后一步；标「仅文档」的步骤只读了上游文档，没有运行。

| 候选 | 层 | 状态 | 停在 | 卡片 |
| --- | --- | --- | --- | --- |
| `claude-code` | helper 后端；也是 host 目标 | 已接入 | 不适用 | `skill/references/claude-code.md`、[档案](../../skill/references/profiles.md) |
| `codex` | helper 后端；也是 host 目标 | 已接入 | 不适用 | `skill/references/codex.md`、[档案](../../skill/references/profiles.md) |
| `kimi` | helper 后端；也是 host 目标 | 已接入 | 不适用 | `skill/references/kimi.md`、[档案](../../skill/references/profiles.md) |
| `pi` | helper 后端 | 已接入；原本会派给 DSH 的活默认走它（2026-10-30 起试用） | 不适用 | `skill/references/pi.md`、[档案](../../skill/references/profiles.md) |
| `dsh` | helper 后端 | 已从默认派工退役（2026-11-06）；安装和 driver 保留；点名启动仍可用 | 不适用 | [档案](../../skill/references/profiles.md)、[入职记录](dsh-onboarding.md) |
| Gemini CLI | helper 后端 | **不接（2026-11-06）**：不再服务个人账号 | 第 2 步 | [gemini-cli](../backends/gemini-cli.md) |
| `agy`（Antigravity CLI） | helper 后端 | 已接入（2026-11-06），走 stream-json 桥接；默认 `gemini-4-argon` / `medium` | 不适用 | [agy](../backends/agy.md)、`skill/references/agy.md` |
| `vibe` (Mistral Vibe CLI) | helper 后端 | 已接入（2026-11-06）；持续桥接 + 原生 resume；默认 `mistral-large-4-0-3` / `high` | 不适用 | [vibe](../backends/vibe.md)、`skill/references/vibe.md` |
| OpenCode | helper 后端 | **候选**：通过第 1、2 步；第 3、4 步仅读文档，未做 spike | 第 4 步，仅文档 | [opencode](../backends/opencode.md) |
| dimAgent | helper 后端（CLI），属于更大的产品族 | **暂缓（2026-11-06）**：两个 CLI 都在变动，其中一个仍是 alpha | 第 2 步 | [dimagent](../backends/dimagent.md) |
| Raft（原 Slock） | 同行运行时 | **参照**；不写 driver | 第 1 步 | [raft](../backends/raft.md) |
| mngr | 同行运行时 | **参照**；不写 driver | 第 1 步 | [mngr](../backends/mngr.md) |
