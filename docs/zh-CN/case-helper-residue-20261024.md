# 案例：助手产物把备份拖垮（2026-10）

## 一句话结论

缺的是“临时工作区”这个类别：助手遵守交接合同，项目保存过程证据，备份引擎坚持保真，三方各自合理的规则叠加后，让临时副本成为长期枚举负担。

本文使用事故任务书的固定快照，不重新统计。`[T]` 表示任务书；`[A]` 表示 ahelpa 提交 `415ac92`；`[P]` 表示该项目的 `dify/ahelpa-evidence-split-20261024/README.md`；`[U]` 表示 `.ahelpa/codex-1ec6959052c9/summary.md` 及其 `artifacts/rescue-candidates.tsv`；`[B]` 表示 Regent-of-Folders 的 `journal/2026-10-24-capture-selection-reuse.md`。后两类项目材料是来源坐标，不是本公开仓库的文件。

## 三方规则为什么各自合理

**ahelpa** 要 reviewer 做临时变异测试，又禁止在结果目录之外写文件。保存测试证据、保护被审代码都合理，但 `src/file-handoff.ts` 的旧 `buildContractSection` 没给工作副本另一处位置，实际只能往 `artifacts/` 放。[A]

**该项目** 用 Git 记工作，用整机备份防丢。其 `.gitignore:168` 起记录：会话产物是“工作过程记录，有追溯价值；已核实不含凭据”。后半句只是当时检查结果，后来已补浏览器缓存排除。“无 remote、git 是唯一备份”涉及另一个私人笔记目录，不能移作这里的入库理由。[T；项目 `.gitignore:168–182`]

**备份引擎** 按完整保真合同工作，`.ahelpa/*` 每个会话打成一个包。捕获前后必须比较清单；正常提交新增 `.git/objects` 也能使捕获无效，避免把不一致状态标成成功。这项保护是正确的。[T、B]

## 规则如何叠加成故障

至少三次变异测试需要副本；副本、pytest 临时目录、uv 缓存进入 artifacts，随后被当成证据入库和备份。最大会话达到 81,643 个条目，前八个约占 400,000 个；前三个来自一次夜间批量变异测试派工。[T、P]

旧 `materializeRoot` 每根运行六条 lane：`all`、`directories`、`normalFiles`、`withoutPack`、`withoutIgnore`、`ensured`。前两条不带用户规则，pack/ignore 之后才做差集，所以打包和忽略都不能省掉全树枚举。[B；引擎 `tools/internal/rcloneselect/materialize.go`]

一次完整捕获重复物化，合成实测达 54 次 rclone 调用。清单窗口变长，既可能耗尽预算，也更容易撞上提交新增对象而作废；并非每次失败都是超时。只撤出 Git 跟踪不减少磁盘条目，不能直接恢复备份。[P、B]

## 时间线

| 日期 | 事件 |
| --- | --- |
| 2026-07-30 | 该项目允许 `.ahelpa/` 入库，理由是过程可追溯。 |
| 2026-10-08 | 夜间批量派工产生后来最大的三个变异测试会话。 |
| 2026-10-12 | 最后一个成功 state。 |
| 不晚于 2026-10-15 | 任务书记载已进入反复超时阶段。 |
| 2026-10-24 | ahelpa 分离 scratch；项目撤出部分跟踪；引擎提交选集复用。 |
| 截至 2026-10-25 | 任务书快照为连续失败 155 轮，尚无新 state。 |

来源：[T、P、B]；日期沿用材料记法，不把不同采样时点合成一次现场测量。

## 已做的修复

**ahelpa，`415ac92`。** `src/runtime-layout.ts` 的 `RuntimeLayout.scratchDir` 提供仓外 `/tmp/ahelpa/scratch/<id>/`；`src/commands/launch.ts` 在 launch/resume 创建目录，注入 `AHELPA_SCRATCH` 和 `TMPDIR`。合同允许 reviewer 写 scratch，副本和缓存去那里，artifacts 只留 patch、日志、报告。`src/evidence.ts` 给 `wait` 增加 `artifactsEntries`，用于发现异常体量，不是自动违规门槛。[A]

**该项目。** 按鉴别清单撤出跟踪并生成精确忽略规则，保留盘上文件；派工规范和交接模板已要求仓外 scratch。实现位置为 `dify/ahelpa-evidence-split-20261024/gen_residue_ignore.py`，规则位置为 `hop/dispatch-policy-v0_1.md` 与 `reference/handback-closing-report-template.md`，均据 [P] 记录；获准材料未提供项目提交号。

**备份引擎，`5b8ca5d` 代码、`d38402a` 记录。** `tools/internal/rcloneselect/materialize.go` 合并目录 lane，`tools/internal/fidelity/capture_plan.go` 和 `tools/internal/hyper/capture_inventory.go`、`capture_stream.go` 复用选集。稳定路径集只物化一次；发现新路径仍重新枚举。清单一致性比较未改。尚未安装，恢复待验证。[B]

## 数字与口径

| 项目 | 固定快照或记录 | 来源 |
| --- | --- | --- |
| 仓库背景 | 2,570 commits；无 remote | T |
| 全仓与会话 | 全仓 823,526 条目；`.ahelpa/` 664,364、3.5 GB；783 会话 | T |
| 集中度 | 前八约 400,000；前三来自 10-08；最大 81,643 | T、P |
| 常见一级目录名 | before、mutations、snapshot、runtime、baseline、tmp、uv-cache、candidate、test-runtime、mutation-copy、__pycache__ | T |
| Git 跟踪 | 114,825；其中 artifacts 112,733；撤出 70,687，剩 44,138；未删盘上文件 | T、P |
| 历史打包体积 | `.ahelpa` 133 MiB／仓库 3.36 GiB，约 3.9% | T |
| 摘要抽样 | 46 份中 43 份关键结论已有转述 | U |
| 产物抽样 | 66 件中 19 件不可再生、24 件存疑 | U |
| 依赖与重复 | 24 处硬读，涉及 21 个历史脚本；14,520 条 artifacts 路径有同内容副本 | U |
| 迁移清单 | 30 行待救援或迁移核对项，不是可直接删除清单 | T、U |
| 文档引用 | 82,247 处路径引用，来自 1,850 文件 | P、U |
| 历史引用 | 最近 300 commits 中 230 个哈希被引用 3,054 次 | T |
| 捕获基线 | 54 次 rclone：源 24、投影 30；182,000 条目夹具耗时 517 秒 | B |
| 源清单分组 | 四组各约 40 秒；引擎记录约 45 秒 | T、B |
| 失败窗口 | 预算 2,400 秒；连续失败 155 轮；末次成功 10-12 | T |
| 引擎修复 | 合成调用 54→15；大夹具耗时 517→493 秒 | B |
| ahelpa 验证 | closure gate 1,717 测试；三个真实会话的 node 编译缓存进入 scratch | T |
| 新会话观察 | 三个 Codex 结果目录各 12–21 条目 | T |

[P] 指出 664,364 是 `find | wc -l` 口径，换行文件名多计 1,700，同次 NUL 安全值为 662,664；这里保留原报告数，不称精确条目数。[B] 后续记到连续失败 156 轮，本文使用任务书的 155 轮快照。抽样结论不外推全量。

## 可推广的规则

给 ahelpa 使用者：

- 把副本、构建临时物和缓存写入 `AHELPA_SCRATCH`，避免它们自动成为长期交付物。
- 将变异 patch、测试输出和结论放入 artifacts，让读者可以检查而不必保留整树。
- 交接时检查 `artifactsEntries` 和内容，因为条目多是排查线索，不是违规证明。
- 忽略旧会话前先迁证据、修脚本输入和引用，因为结论已有转述不等于原件无用。

给交接目录、版本库与备份组合：

- 分别定义工作区、证据和运行状态的去处与寿命，因为一个目录名不能表达保留责任。
- 分别测量入库量、盘上条目和备份枚举量，因为三者由不同规则决定。
- 让临时目录位于所有相关备份根之外，因为只移出当前仓库可能仍被上层枚举。
- 优先复用同轮观察并保留变化检测，因为减少重复扫描无需牺牲一致性。

## 没修、没验证、有争议的

存量目录尚未移出，独特证据与脚本依赖尚未迁完。“九成以上是副本缓存”来自任务书的总体判断，抽样不足以证明每件可删。[T、P、U]

不重写历史：历史体积占比小，且文档依赖提交哈希；洗历史不能解决盘上枚举。项目分类含路径与引用启发式，并未逐件证明可再生。[T、P]

ahelpa 新会话观察不是长期保证；本次写作未重跑 gate。引擎合成调用下降不等于耗时同比下降，更不等于生产恢复；打包、遍历和并发写入仍可能成为瓶颈，必须等安装后的成功 state。[T、B]
