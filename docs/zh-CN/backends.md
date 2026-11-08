# Helper 后端：接什么、怎么判断、怎么接

[English](../backends.md) | [简体中文](backends.md)

本页回答三个问题：什么样的 agent 适合接成 ahelpa 的 helper（**接什么**），怎么判断（**怎么判断**），大致怎么接（**怎么接**）。末尾附一份「已评估候选」登记表。写于 2026-11-06，对应 ahelpa 0.10.0；2026-11-07 把两种接法收成了一种（见[怎么接](#怎么接)）。

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
| **helper 后端** | 本身就是干活的 agent harness：读文件、改文件、跑命令、调模型。 | driver 候选，进入漏斗。 | `claude-code`、`codex`、`kimi`、Pi、`agy`、Vibe；候选 OpenCode |
| **host 目标** | *调用* ahelpa 的 agent，对应 skill 安装目标，不是 driver。同一个 agent 可以两者都是。 | 是 skill 安装问题，不是 driver 问题。 | skill 目标 `codex`、`claude-code`、`kimi-code-cli`（三者同时也是 helper 后端） |
| **模型／网关层** | 位于 driver 之下：provider 端点、路由、密钥代理，或无状态的模型 CLI。 | 是某个现有 driver 的配置，绝不是新 driver。 | Kimi `config.toml` 里的 provider、Pi 的 `provider/id` 模型、`gemini-api` |
| **同行运行时** | 和 ahelpa 处在同一层的编排或管理工具。 | **参照，不是拒绝。** 吸取经验，必要时考虑互通，不写 driver。 | Raft、mngr、oar |
| **套壳／桥接** | 别人给某个 agent 做的插件或 bridge。 | 去评估它底下那个 agent，不评估壳。 | `raft-acp-bridge`、mngr 的 `mngr_antigravity` 插件 |

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
| **它自己的交互式 TUI 能在 tmux 里跑、能接收按键、能从 pane 读出来。** | session 就是跑着厂商界面的 tmux session：daemon 抓它的 pane，`send-keys` 投递输入，`tmux attach` 让人能看见、能插手。headless 和 RPC 模式不算（见[怎么接](#怎么接)）。 |
| **一个会话里能多轮。** | `send`/`task` 把追问送进活着的 pane。做不到，helper 就退化成「每次交付一个进程」，而这已被[拒绝](#拒绝过的设计)。原生恢复是可选的（[原因](#怎么接)）。 |
| **无人值守时不必改全局配置**（提案条目 A6）。 | 启动不能改写用户的 CLI 设置之类的文件：爆炸半径会波及他们自己的所有会话。hook、权限、信任必须能靠启动旗标、环境变量或会话级文件设置。必须持久化信任的，是有文档记载的例外（见[安全说明](security.md)），不是默认。 |
| **能读任务文件、写结果目录、打印暗号。** | 文件交接加暗号是唯一的完成约定；ahelpa 优先文件，而不是解析终端输出。 |
| **自更新不会打断运行中的会话。** 要么有开关能关掉，要么可证明只在下次启动时生效，要么 driver 能关掉它的弹窗。 | 会话中途替换二进制或弹出阻塞对话框的更新，会破坏就绪检测并杀死常驻 helper。树内的 driver 用三种不同办法满足这条（见下面的矩阵）；会替换二进制的后台更新器是最坏情形，必须有开关。 |

### 第 4 步：软能力（决定接到哪一档，不决定能不能接）

| 能力 | 因为 |
| --- | --- |
| **结构化的回合结束信号和输入归属**（会话级 hook 或 notify 命令）。 | 没有它，daemon 只能靠不活动推断回合结束；归档里 63 个 Claude `needs_attention` 会话有 47 个已经写好 summary 却没打暗号（提案 A6）。 |
| `--model` 和 `--effort` 旗标。 | `launch --model/--effort` 和角色预设靠它们设置。没有就用原生默认值，这是允许的。 |
| 低权限姿态（`--safe`）。 | `--safe` 承诺的是「在支持处」。上游没有低权限姿态的，driver 必须**拒绝**这个旗标（Pi 就是如此），而不是忽略。 |
| 会话级信任。 | 持久信任会在会话之外写状态（Codex 和 Kimi 就是，见[安全说明](security.md)）。会话级信任可避免。 |
| 运行时切模型。 | `ahelpa model` 要靠它驱动运行中的 helper。可选。 |

通过漏斗只回答**能不能**接，不回答**该不该**接。后者由负责人定：它覆盖了现有 driver 覆盖不到的什么需求？比如在 Pi 旁边再接一个同样不绑 provider 的开源 harness，理由不能只是「接得上」。

## 怎么接

**规则（负责人决定，2026-11-07）：人怎么用一个 helper，ahelpa 就怎么驱动它——在 tmux 里跑它自己的交互式 TUI。** ahelpa 用 `send-keys` 打字，用 `capture-pane` 读屏。headless、print、RPC、stream-json、ACP 这些模式一律不作为 helper 的传输方式，tmux 和 agent 之间也不夹任何桥接程序。TUI 没法这样驱动的上游，直接拒绝并记进登记表，不做桥接。

怎么运作：

- **身份。** helper 就是它的 ahelpa ID（`<前缀>-<12 位十六进制>`），也就是 ahelpa 启动时给 tmux 会话起的名字。`send`、`interrupt`、`capture`、`attach`、`kill` 只靠它。CLI 自己的对话 ID 是可选的：它只用来让 `resume` 重新打开进程已经没了的 helper，这很少见。driver 只在 CLI 本来就会显示它的地方记下来（首次提交之后，或 DONE 之后的退出画面），绝不为了拿它而按键或拖慢 kill；CLI 没有原生恢复时，四个恢复成员整组不写，`resume` 直接拒绝（负责人决定，2026-11-08）。
- **输入。** 任务以文件交给 helper。pane 里只通过 `send-keys` 收到一段简短指令（`Please read and complete the task described in <path>`，外加怎么打暗号的说明）。这段指令会在句中提到暗号，但暗号只有单独占一行才算数，所以不会误判。`send` 和 `task` 也用同样的方式把追问敲进去。
- **结果。** 屏幕说了算。当前回合的输出里，在最后一次「还在干活」的迹象之后出现 `[AHELPA:DONE]` 或 `[AHELPA:NEED_HELP:tags]`，这一回合就结束了（`src/drivers/sentinels.ts`；Kimi 的 `detectOutcome` 是最朴素的例子）。daemon 每 3 秒抓一次，所以打了暗号的回合最多一次抓屏就结算；有回合结束 hook 叫醒它时，立刻结算。
- **没有暗号。** 连续 4 次定时抓屏（约 12 秒；hook 提前叫醒的那次不算；`src/daemon.ts` 里的 `IDLE_DEBOUNCE`，2026-06-24 定的，没有实测依据）都看不到干活迹象，daemon 就提醒 helper，或把会话标成 `needs_attention`。driver 不认识的对话框也走这条路：叫人。这只是兜底；干活中的 helper 该得到以分钟计的耐心，而不是秒。不要为了早几秒发现「悄悄停了」去压短它：一次误报会白白叫醒 host，还诱使它打断或 kill 正在进行的活，代价远大于省下的几秒。要更快认出「活干完了」，只靠正面信号：暗号，以及 CLI 支持按次启用时的回合结束 hook（负责人决定，2026-11-08）。
- **hook 只加速，不裁决。** Claude Code（`--settings` 文件）、Codex（`-c notify=[...]`）、Pi（用 `-e` 加载的单文件扩展）、Vibe（`--add-dir` 传入的目录里的 `hooks.toml`）和 agy（同样方式的 `hooks.json`）注册会话级的回合结束 hook，经隐藏命令 `__turn-hook` 往 `.ahelpa/<id>/turns.log` 追加记录，并叫醒 daemon。它告诉 daemon 回合*什么时候*结束：干完的回合立刻被读到，不用等下一次抓屏（2026-11-08 实测，hook 还不会叫醒 daemon 时，八个 Codex helper 从 hook 触发到结算最多等了 5 秒，平均约 2.3 秒；在 0.14.0 上，Pi、Vibe 和 agy 打出暗号的回合在 hook 后 0.54 到 0.57 秒内结算）；「没有暗号」那种情况的等待也会缩短；事件还能对到正确的那次输入上。Vibe 和 agy 的事件只叫醒 daemon：Vibe 的 payload 不带输入；agy 会跑完所有 `Stop` handler，排在 ahelpa 之后的项目或插件 handler 仍可能让回合继续。它从不说明活是否干成了（「Hooks never imply success」，见[架构](architecture.md)）。CLI 提供能按次启用、不碰用户配置的回合结束 hook 时，driver 就接上（负责人决定，2026-11-08）；其余的只靠读屏。
- **driver 只需要知道这些，不多也不少。** 启动命令（关自动更新、权限姿态、尽量只信任本次会话）；空着、可以输入的输入框长什么样；干活时长什么样（转圈、计时、打断提示）；哪些对话框需要人（只有会话级信任可以自动回答）；打断键和退出命令；可选的：原生恢复 id 打印在哪，以及恢复命令。
- **生命周期。** 进程归 tmux 管。DONE 之后 daemon 发退出命令，退出画面若打印了原生恢复 id 就记下来。`kill` 立即结束 tmux 会话，不按任何键。`interrupt` 只停一个回合，会话留着等 `send` 或 `task`。人随时可以 `tmux attach` 看到真实界面。

### 为什么是终端，不是桥接

- **人永远能看见、能插手。** `tmux attach` 看到的就是 agent 自己显示的东西：它在读什么、跑什么、改什么。人可以打字改方向，按 CLI 的打断键只停当前回合、保留会话，回答对话框，或者切模型。桥接时代，attach 进去只能看到状态标记，最后才出现最终回答；敲进去的一行会变成排队的新任务；单独停一个回合做不到，只能结束整个会话（agy 收到 SIGINT 会整个进程退出）；headless agent 提的问题会拿到空回答（agy 的 `ask_question`），人根本不知道它问过。
- **所有 helper 一个裁判。** 同一套暗号、同一种回合范围、同一套提醒、同一套 `send`、`wait`、`check`。每个桥接都按自己的规则结算回合、打印自己的标记，等于每个后端多一个裁判。
- **不用自己当进程管理器。** 进程树归 tmux 管。每个桥接都得给子孙进程拍快照、发信号、按记录的身份回收孤儿进程，Pi 还要加锁防并发写。这些代码之所以存在，只是因为 agent 离开了终端。
- **也不更省代码。** 连同桥接一起，agy、Vibe、Pi 的 driver 分别是 433、438、589 行；Kimi 的纯读屏 driver 是 486 行（2026-11-07，对 `src/drivers/` 跑 `wc -l`）。
- **厂商的 TUI 才是厂商给人用、并负责维护的那一面。** 斜杠命令、模型菜单、审批和信任对话框、插件都在上面，headless 模式会把它们丢掉。这也是[拒绝 ACP](#拒绝过的设计) 的理由之一。

### 不足以让我们离开终端的理由

这些是当初支持桥接的说法，2026-11-07 逐条核对过：

- *「TUI 每个版本都在变。」* 输入这一侧是按键，不会变。暗号是模型自己打出来的字，跟界面无关，所以界面改版不可能把没干完的活变成 DONE。最坏的情况是某个干活迹象或新对话框认不出来，约 12 秒后标成需要人看，或者启动时明确报错。driver 会关掉自动更新，所以界面变化只会在负责人自己升级时出现，`doctor` 和 closure gate 会检查版本。
- *「结构化事件能给出精确的回合结束。」* 暗号加屏幕已经能在一次抓屏内结算回合。没打暗号的情况有防抖时间兜底；CLI 提供会话级 hook 的，还能再缩短。
- *「第一条消息之前就能拿到恢复 id。」* helper 活着的时候，`send`、`capture`、`attach`、`kill` 只需要它的 ahelpa ID，也就是 tmux 会话名。原生 id 只在重新打开进程已经没了的 helper 时才用得上，这很少见。DONE 之后退出时 CLI 会打印它。`kill` 会保留已经记下的 id（Kimi 首次提交后的，或 resume 出来的 helper 继承的），但绝不为缺的 id 去取；CLI 自己的历史里仍列着那段对话。
- *「厂商推荐自动化用 headless 模式。」* ahelpa 跑的不是无人值守的流水线，而是给 host agent 配一个人能随时过目的同事。

### 偏离是怎么发生的

记下来，免得重蹈覆辙：

- **2026-10-30。** Pi 以 RPC 桥接的形式接入（提交 `03598f7`），目的是让它对 host 的接口和某个现有 driver 一致。提交里没有记录跟 Pi 自己的 TUI 做过比较。
- **2026-11-06。** 本页写成时列了两种接法，并建议读者优先桥接、不要抓屏，把 Pi 的选择变成了规则。spike 清单问了结构化模式，却从没问过 attach 进去还能不能看到 agent。
- **2026-11-06。** agy「照 Pi 的形状」接入，尽管它自己的 spike 已经证明 TUI 这条路走得通（会话级信任、会话级 hook、暗号能抓到），那条路只被留作备选。Vibe 的评估卡从没评估过 Vibe 的 TUI。
- **2026-11-07。** 负责人 attach 到一个 `gemini` helper，看不到任何进展，追问这三个后端为什么跟 Claude Code、Codex 不一样，于是定下上面的规则。Pi、agy、Vibe 都迁到了各自的 TUI（见它们的评估卡）。

教训：为一个后端做的选择变成了规则，而没有人重新说出它牺牲掉的原则（`tmux attach` 是人的后门）。先例不是理由。新 driver 要对照本页的原则来检查，而不是对照上一个写出来的 driver。

## 最低可接受的 driver

底线是[硬门槛](#第-3-步硬门槛)加上 `AgentDriver`（`src/drivers/types.ts`）的 11 个必选成员：`name`、`sessionPrefix`、`modelCatalog`、`buildLaunchCommand`、`prepareForTask`、`afterTaskSubmitted`、`switchModel`、`detectStatus`、`detectOutcome`、`detectActivity`、`gracefulExit`。其余十二个是可选的：`turnHooks`、`prepareLaunchFiles`、`launchProfiles`、`checkReadiness`、`acceptsInput`、`acceptsInputAfterTurn`、`workingAfterTurn`、`interrupt`，以及要么全写、要么全不写的四个恢复成员（`resumeTokenAvailableAfterSubmit`、`buildResumeCommand`、`extractResumeToken`、`prepareForResume`）。

这条底线真实存在的证据是 `kimi`：没有回合 hook、没有 `--effort`、不能运行时切模型，照样是正式支持的 driver。Pi 走得更远，直接拒绝 `--safe`。所以要把两个问题分开回答：

- **能不能接？** 看硬门槛。
- **接到哪一档？** 底线（只过门槛）→ 加结构化的回合结束信号 → 再加 model/effort、safe 姿态和运行时切换。缺少软能力只会降档，不会挡住准入。
## Driver 能力矩阵

2026-11-06 据 `src/drivers/*.ts` 和 `skill/references/*.md` 手写；Pi、agy、Vibe 三列在 2026-11-07 按它们的 TUI driver 更新。同样的列也是新候选的打分格子：评估卡的「Grid」一节照此填写。

| | `claude` (Claude Code) | `codex` | `kimi` | `deepseek-pi` (Pi) | `gemini` (Antigravity) | `mistral` / `deepseek` (Vibe) |
| --- | --- | --- | --- | --- | --- | --- |
| 形态 | TUI + hook | TUI + hook | TUI，无 hook | TUI（全屏）+ hook | TUI + 只叫醒的 hook | TUI + 只叫醒的 hook |
| 恢复 token（`resumeTokenAvailableAfterSubmit`） | 仅退出后可得（draining 期间捕获） | 仅退出后可得（draining 期间捕获） | 首次提交后立即可得（原生 `session_*` id） | 仅退出后可得：`/quit` 退出提示里的 `pi --session <uuid>`（draining 期间捕获） | 仅退出后可得：退出时打印的 `agy --conversation=<id>`（draining 期间捕获）；未知 id 让 resume 失败 | 仅退出后可得：退出时打印的 `vibe --resume <8 位十六进制>`（draining 期间捕获）；桥接时代记录的完整 UUID 仍能恢复 |
| 回合结束信号 | 经 `--settings` 会话文件的 hook：`UserPromptSubmit`、`Stop`、`StopFailure` | 单次调用的 `-c notify=[...]` 覆盖（`agent-turn-complete`） | 无；不活动启发式加暗号 | 会话扩展（`-e .ahelpa/<id>/pi-turn-hook.mjs`）转发 `agent_settled`；暗号须是对话记录最后一行且没有转圈 | 会话 `--add-dir` 目录里的 `Stop` hook（`.agents/hooks.json`）叫醒 daemon（别的 Stop handler 可能让回合继续，所以它不参与裁决）；当前回合里的暗号之后没有转圈或后台任务，否则靠不活动判断 | 会话 `--add-dir` 目录里的 `post_agent` hook 叫醒 daemon（不带输入，不参与裁决）；最新回合里最后一个转圈行之后的暗号，否则靠不活动判断 |
| `--safe` 的含义 | 去掉 `--dangerously-skip-permissions`，原生审批仍在；结果目录在项目外时加 `--add-dir` | `-s workspace-write -a never`（加 `--add-dir`） | 用 `--yolo` 取代 `--auto`（高风险动作仍会询问）；不是沙箱 | 拒绝 | 拒绝 | 拒绝 |
| 信任是否持久化 | driver 不管；用户须先在项目里跑一次 `claude`，否则启动快速失败 | 是：回答「Folder access」（0.163+）会把仓库根写成受信任，保存在 Codex 配置里；hooks 信任提示用 Escape 暂时拒绝 | 是：两种模式都会选「Trust and continue」，由 Kimi 持久化 | 否：`--approve` 只在本次运行信任项目文件 | 否：`--settings '{"trustedWorkspaces":[…]}'` 只信任本次会话 | 否：`--trust` 仅本次调用 |
| 自更新 | driver 未压制（上游行为未在此核实） | 更新对话框用「Skip」跳过；未压制 | `KIMI_CODE_NO_AUTO_UPDATE=1` | `--offline` 跳过 Pi 启动时的更新和目录检查 | `AGY_CLI_DISABLE_AUTO_UPDATE=true`（1.5.2 只认小写 `true`；设成 `1` 仍会拉起更新进程） | `VIBE_ENABLE_AUTO_UPDATE=false`, `VIBE_ENABLE_UPDATE_CHECKS=false` |
| 模型／effort | 启动时 `--model`、`--effort`；运行时经模型菜单切换 | `--model`、`-c model_reasoning_effort=`；运行时经模型菜单切换 | 只有 `--model <config.toml 别名>`；无 effort；不能运行时切换 | `--model provider/id`，`--effort` 以 `--thinking` 传入；页脚显示的模型和级别与请求不符就启动失败（Pi 会静默降级）；不能运行时切换 | 默认 `--model gemini-4-argon --effort medium`；带后缀的 id（如 `gemini-4-argon-high`）须配同名 `--effort`；不能运行时切换 | 会话 agent TOML 由 pane 在启动 `vibe` 前写入：分别默认 `mistral-large-4-0-3` / `high` 和 `deepseek-v4-1-flash-1017` / `high`；不能运行时切换 |
| 最后验证的上游版本 | 树内未记录固定版本；`doctor` 报告已安装版本 | 0.163+（Folder access）；容量短语见于 0.154；更新对话框格式 ≤0.15x 与 0.160 | Kimi Code 2.x（`--auto` 需要） | 接受 ≥ 1.4.0；TUI 在 1.5.0 上测试（2026-11-07） | 接受 ≥ 1.5.2；TUI 在 1.5.3 上测试（2026-11-07） | TUI 在 3.1.0 上测试（2026-11-07） |

ponytail: 手写会和代码漂移；漂移真正造成麻烦时，再改成从 `AgentDriver` 生成。

## Spike 清单

对通过漏斗第 1、2 步的候选，在临时目录和临时 home 里跑一遍。这是 agy 用过的七个问题，抽象成了通用模板。每个答案都要记下命令、上游版本和日期。

> 先注意副作用：运行 agent 二进制可能改变这台机器。agy 的后台更新器，哪怕你只运行 `agy models`，也可能替换已安装的二进制（第三方在 1.1.22 上报告；在 1.5.2 上把开关设成 `1` 仍会拉起更新进程，只有小写 `true` 有效）。优先用 `--help` 和 `--version`，并且在运行其他任何东西之前先设好更新开关。

1. **tmux 里的登录与首次引导。** 登录能在 pane 里完成吗？凭据存在哪（文件还是系统钥匙串；无头用户可能没有钥匙串）？哪种账号类型可用？首次启动会出现哪些画面（主题、提示、信任、遥测同意），每个都有能关掉它的按键吗？
2. **自更新。** 由什么触发（前台检查还是脱离终端的后台更新器），替换什么，怎么关（旗标、环境变量、配置）？能固定版本吗？
3. **恢复 id（可选）。** CLI 有没有？什么时候生成（启动时、首次提交后、退出时），从哪里读（pane、文件、API），能预先指定吗？恢复能和姿态、模型、effort 旗标组合吗？没有原生恢复的 CLI 也可以接。
4. **skip-permissions 之后还剩哪些提示。** 打开上游的「全部放行」旗标后，还有哪些对话框（目录信任、hooks 信任、MCP 审批、工具专属的「危险」确认、更新、引导），哪些能靠按键回答？
5. **会话级 hook 与设置。** hook、权限、信任能只对一个会话注册（旗标、环境变量、会话级文件）吗？唯一途径若是全局文件，A6 门槛就不过。会话文件和用户自己的配置怎么合并？
6. **暗号经过渲染后还能不能抓到。** 让 agent 通过真实 TUI 打印 `[AHELPA:DONE]`，在窄宽两种终端宽度下用 `tmux capture-pane` 抓：折行、markdown 渲染、面板、颜色码、滚动缓冲。还要看 agent 会不会回显任务文本（被引用的暗号是误报）。
7. **静止时长、打断和退出。** 回合干活期间，抓到的屏幕完全不变的最长一段有多久（比如等 API 时）？没打暗号时的防抖时间必须比它长。哪个键能只停当前回合，会话还在不在？哪个命令能干净退出，退出画面会不会打印原生恢复 id？CLI 有没有能按次启用、不碰用户配置的回合结束 hook？

Spike 决定这个 TUI 到底能不能驱动（不能就拒绝，不做桥接），以及接到哪一档。答案写进候选的评估卡。

## Spike 之后

1. **实现。** `src/drivers/<name>.ts`、在 `src/drivers/registry.ts` 注册、带合成 pane fixture 的测试，以及所有其他枚举 driver 的地方（见[添加 driver](development.md#添加-driver)）。
2. **Closure gate。** 在 `bun run closure:gate` 里加一个场景。计费型或付费后端只在设置了 `AHELPA_GATE_<NAME>=1` 开关时运行。gate 必须显示 `wait`/`check` 能观察状态、`kill` 能回收 session；driver 支持 resume 的，还要验证原生 resume 和上下文连续性。
3. **入职观察。** 记录带日期的配置与证据边界、观察到的工作风格、暂定派工选择，以及说明每个练习**没有**证明什么的验收表。
4. **档案。** 把这个 helper 写进 `skill/references/profiles.md`（擅长什么／要留意什么／怎么给任务／运行时怪癖，外加观察状态）以及一页 `skill/references/<name>.md` 配置说明。默认派工的决定跟着档案走，不要反过来。

### 退役一个后端

退出默认派工和删除 driver 是不同决定。记录作者的决定，并在同一天更新登记表。删除 driver 时，旧记录仍须可检查、可回收；经已移除 harness 提交新任务必须明确拒绝。

## 拒绝过的设计

这些决定来自 2026-10-08 的设计提案（ahelpa v0.9.0，§6），至今有效。列在这里是为了能 grep 到。要再次提议之前，先读理由。

| 设计 | 为什么不做 |
| --- | --- |
| **MCP server 接口** | host 本来就能 shell out，用法由 skill 文档驱动；`wait` 能阻塞几分钟，适合 CLI 调用。MCP 接口的代价是每次升级都要在每个 host 上刷新 schema、迁移参数。万一以后真要，就从 `src/command-contract.ts` 生成一个薄包装，绝不另立第二份契约。 |
| **工作流引擎或团队文件运行器** | host LLM 是指挥者，必须仍由它读证据、决定是否交付。只会转述 performer 自述的指挥者不够用：归档里自述与独立复核分歧太多。零运行时的替代方案是任务文件模板。 |
| **满权限作为唯一姿态** | 永远满权限的工具不会被卡住，代价是没有更低的姿态。ahelpa 默认以本地满权限启动（[安全说明](security.md)里直说了），但凡上游有更低姿态就保留 `--safe`；没有的，driver 拒绝这个旗标。 |
| **每次交付一个进程、不持久** | 它去掉了 daemon，代价是丢掉所有在途工作。tmux 加 SQLite 意味着任何一个 ahelpa 进程死掉，在途工作都不会丢。 |
| **共享 transcript 或不设界的 agent 间循环** | 只有 host 转发。`--after` 仍是 host 选定的、指向文件的指针。有界的替代方案是 job 范围、有预算、基于文件的 peer mail，它不授予控制权，也不能改派任务。 |
| **以 ACP 作为传输层** | 四点理由说明这是错误的赌注：(1) 同时驱动九种 agent 的 MCP 工具 Confer，对 Claude 和 Codex 也不依赖 ACP，而是用进程内桥接去连厂商自己的官方接口；(2) Claude Code 和 Codex 没有第一方 ACP，只有它们自己的结构化接口，第三方适配层必然落后于变化快的 CLI；(3) 会丢掉只有 CLI 才有的能力（斜杠命令、模型菜单、审批与信任对话框、插件触发、`tmux attach`）；(4) ACP 是 stdio 会话，持有客户端那一端的进程一死会话就丢，而 ahelpa 的设计正是为了不存在这样的进程。已经拿到大部分价值的增量做法是结构化的回合结束 hook。针对某个上游、基于厂商自己结构化模式的桥接同样被拒绝，见下一行。 |
| **以 headless 或结构化桥接（print、RPC、stream-json）作为 helper 的传输方式** | 2026-10-30 至 2026-11-07 用于 Pi、agy、Vibe，之后移除。人 attach 进去看不到进展，没法改方向，也没法单独停一个回合，还看不到 agent 提的问题。每个桥接都自成一个回合裁判、自成一个进程管理器，代码量也和读屏 driver 差不多。见[为什么是终端，不是桥接](#为什么是终端不是桥接)和[偏离是怎么发生的](#偏离是怎么发生的)。 |

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

2026-11-07 更新。公开 helper 类型不必等于 harness 名：Vibe 对应 `mistral` 和 `deepseek`（Mistral 订阅）；Pi 对应 `deepseek-pi`（先在 CC-Switch 中配置 DeepSeek 并同步到 Pi）。小名和内部 harness ID 见[名字目录](../../skill/references/names.md)；数据库只存 harness ID。「停在」指候选被检验到的最后一步；标「仅文档」的步骤只读了上游文档，没有运行。

| 候选 | 层 | 状态 | 停在 | 卡片 |
| --- | --- | --- | --- | --- |
| `claude` (Claude Code) | helper 后端；也是 host 目标 | 已接入 | 不适用 | `skill/references/claude-code.md`、[档案](../../skill/references/profiles.md) |
| `codex` | helper 后端；也是 host 目标 | 已接入 | 不适用 | `skill/references/codex.md`、[档案](../../skill/references/profiles.md) |
| `kimi` | helper 后端；也是 host 目标 | 已接入 | 不适用 | `skill/references/kimi.md`、[档案](../../skill/references/profiles.md) |
| `deepseek-pi` (Pi) | helper 后端 | 已接入；`deepseek` 的官方 DeepSeek API 备份，需经 CC-Switch 同步。自 2026-11-07 起经 TUI 驱动（2026-10-30 至 2026-11-07 为 RPC 桥接） | 不适用 | [pi](../backends/pi.md)、`skill/references/pi.md` |
| `dsh` | helper 后端 | **已移除（2026-11-06）**：作者决定；花活太多，CLI 友好度一般 | 已移除 | 旧记录仍可检查与回收，不再接受任务或恢复 |
| Gemini CLI | helper 后端 | **不接（2026-11-06）**：不再服务个人账号 | 第 2 步 | [gemini-cli](../backends/gemini-cli.md) |
| `gemini`（Antigravity CLI） | helper 后端 | 已接入（2026-11-06）；自 2026-11-07 起经 TUI 驱动（此前一天为 stream-json 桥接）；默认 `gemini-4-argon` / `medium` | 不适用 | [agy](../backends/agy.md)、`skill/references/agy.md` |
| `mistral` / `deepseek` (Mistral Vibe CLI) | helper 后端 | 已接入（2026-11-06）；自 2026-11-07 起经 TUI 驱动（此前为 headless 桥接）；分别默认 `mistral-large-4-0-3` / `high` 和 `deepseek-v4-1-flash-1017` / `high` | 不适用 | [vibe](../backends/vibe.md)、`skill/references/vibe.md` |
| OpenCode | helper 后端 | **候选**：通过第 1、2 步；第 3、4 步仅读文档，未做 spike | 第 4 步，仅文档 | [opencode](../backends/opencode.md) |
| dimAgent | helper 后端（CLI），属于更大的产品族 | **暂缓（2026-11-06）**：两个 CLI 都在变动，其中一个仍是 alpha | 第 2 步 | [dimagent](../backends/dimagent.md) |
| Raft（原 Slock） | 同行运行时 | **参照**；不写 driver | 第 1 步 | [raft](../backends/raft.md) |
| mngr | 同行运行时 | **参照**；不写 driver | 第 1 步 | [mngr](../backends/mngr.md) |
