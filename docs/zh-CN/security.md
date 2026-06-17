# 安全说明

[English](../security.md) | [简体中文](security.md)

## 权限模型

ahelpa 启动的 helper agent 拥有和 host process 相同的本地用户权限。它没有 sandbox，没有 capability restriction，也没有介于 helper 和本地文件系统之间的审批 gate。helper 能读取、写入和执行该用户账号能做的事情。

这是本地开发场景下的刻意取舍：最大化 helper 能力，同时要求使用者认真收窄任务范围。

## 实用防护

- **用 `--project` 收窄范围。** 把 helper 指向最小可用工作目录。只需要 review 某个模块时，不要给它整个 home directory。
- **使用 git worktree。** 风险任务或实验任务放进临时 worktree，降低误改主工作区的影响。
- **不要把 secret 放进任务 prompt。** 任务文件会写到 `/tmp/ahelpa/`，本地用户可读。不要在任务描述中嵌入 credential、API key 或敏感数据。
- **不要把 secret 留在结果 artifact。** Helper 会把结果写到项目内 `.ahelpa/<session-id>/`。commit 或分享前先检查。
- **不要提交运行时 artifact。** `.ahelpa/`、本地数据库、日志、构建输出都应保持 git-ignored。

## Owner token 边界

`launch` 返回的 owner token gate 所有写操作：

| 需要 token | 不需要 token |
| --- | --- |
| `send`、`task`、`capture`、`logs`、`kill` | `status`、`check`、`clean` |

只读状态视图不会暴露 owner token。这意味着任何 agent 都可以观察 session 状态，但只有启动者能交互或终止该 session。

Ownership 不传递。如果 agent A 启动 helper B，helper B 又启动 helper C，那么 A 不能控制 C；只有 B 可以。

## Nesting limit

Helper 可以继续启动 helper，但有最大深度限制，默认 4。这样可以避免无限递归 spawn。限制由 `AHELPA_MAX_NESTING_DEPTH` 配置，并在 launch 时校验。

## 暗号可信度

暗号协议（`[AHELPA:DONE]`、`[AHELPA:NEED_HELP]`）是约定，不是密码学保证。helper 可以在未真正完成时打印暗号，也可能完全忘记打印。daemon 通过 tmux capture 检测暗号，也就是读取 helper 控制的终端输出。

在本地 agent 场景中，这通常是可接受的：helper 是本机可信 agent CLI，权限模型本身也假设它能代表用户执行任务。

## 生成物和本地文件

公开源码树会忽略：

- 本地 runtime state（`~/.ahelpa/state.db`、`daemon.pid`、`daemon.log`）
- Session archives（`~/.ahelpa/archive/`）
- 生成的 build output（`dist/`）
- 生成的 skill bundle（`skill/bundle/`）
- 环境文件（`.env`、`.env.*`）
- key 和 certificate 文件
- 项目内 session 目录（`.ahelpa/`）

## 发布 hygiene

发布公开仓库前：

1. 跑 `bun test` 确认测试健康。
2. 扫描 tracked files 中的敏感字符串：本机路径、credential、私有名字、内部 URL。
3. 确认 git history 从预期的 clean commit 开始。
4. 确认生成物没有被 stage。
