# 本地 Copilot 执行

> 简体中文（主要版本） | [English](trusted-local.md)

## 前提与信任边界

需要 Node.js 22.13+、Git、已安装并单独完成认证（或配置 BYOK）的 Copilot CLI，
以及 `npm ci` 和 `npm run build`。Windows 需要 Job Object 和随 Package 安装的
`koffi` 原生绑定，不再需要 Windows PowerShell/.NET 或运行时编译器；Linux 需要
可读 `/proc`。原生绑定缺失或无法加载时明确拒绝启动，不降级到 PID 查找/终止。
其他平台目前拒绝 native launch。
Windows 的 `TORSOR_COPILOT_COMMAND` 应指向原生可执行文件，而不是 `.cmd`/`.ps1` shim。
依赖安装和构建不启动真实模型。使用可信的仓库、用户配置、自定义指令和 MCP server。
Linux 工具后代必须留在原进程组中；主动 daemonize/脱离进程组的工具不受支持。

`restricted` 是默认、确定性 deny-by-default 工具配置；`trusted-local` 必须显式选择。
后者让 Provider 使用普通 shell、文件、URL、自定义指令、已配置 MCP 和正常用户环境。
它不是 hostile-code 沙箱：Provider 具有用户本机权限，cwd/Lease 不是访问隔离。
不要在共享不可信 Host 上使用。外部 API/MCP 效果不具有 exactly-once 保证。

`TORSOR_*`、`COPILOT_ALLOW_ALL`、`COPILOT_ASSISTED_APPROVAL` 不进入 Provider 环境。
认证始终由 Provider 管理；不要把凭据放入 Prompt、bootstrap、Thread、报告或日志。
Attention 判断始终受限；只有已分配 Worktree 的 Run 可执行 native tools。

## Host 配置

先按 [Server 实现参考](../apps/server/README.md) 配置 bootstrap、数据库、HTTP
认证、Human Principal、Runtime Principal 和 Project IDs。新增配置如下：

| 变量 | 要求 |
|---|---|
| `TORSOR_PROVIDER_POLICY` | 默认 `restricted`；显式 `trusted-local` |
| `TORSOR_PROVIDER_PERMISSION_MODE` | trusted-local 必填 `provider-default` 或 `allow-all`；restricted 禁止设置 |
| `TORSOR_REPOSITORY_PATH` | 可信本地 Git 仓库 |
| `TORSOR_WORKTREE_ROOT` | 私有 dedicated root；不要与仓库内容或其他数据库共享 |
| `TORSOR_BASE_REVISION` | 完整不可变 commit ID，不接受 `main` |
| `TORSOR_COPILOT_COMMAND` | 可选 Provider 可执行文件；默认 `copilot` |
| `TORSOR_PROVIDER_TIMEOUT_MS` | 1000–295000；trusted-local 默认 120000，restricted 默认 25000 |

Trusted-local 禁止 `TORSOR_PROVIDER_CWD`。Runtime 从 Run 分配推导目录并按固定 commit
创建 detached Worktree；未登记的残留目录不会自动收养。数据库和 root 绑定。
`provider-default` 不批准无人值守 permission 请求；需要无人值守工具工作时必须明确
选择 `allow-all`。这不授予 Kernel authority，也不绕过停止或发布围栏。

运行 `npm run start --workspace @torsor/server`。首次写入前获取 Writer Lease 和 receipt，
绑定 Activation、Run、ProviderAttempt、generation、fencing 和原进程树。
Windows 只启动 Package 内固定的深层 Node owner module；不从环境、`PATH`、当前目录
或可变缓存选择 owner。该 module 通过 `CreateProcessW(CREATE_SUSPENDED)` 创建
Provider，先加入 `KILL_ON_JOB_CLOSE` Job Object，再恢复原线程。
取消、过期或关闭先停止进程，再持久化证据；未知停止隔离目录，禁止 replacement Writer。
丢失原 handle 后重启不会清除隔离。当前使用 schema 18；schema 17 被拒绝。
停止旧进程，显式使用新的可丢弃数据库和新的 managed root；不迁移、不自动删除。

Timeline 只保留归一化 Tool started/completed/failed 与来源，不保留原始 Tool IDs、
参数、结果、命令路径、stdout/stderr 或 ACP Session IDs。最终 Reply/报告是明确的公开
actions；不要把私有资料放进去。失败使用固定公开诊断。

## Smoke 与可重复验证

`npm run test:trusted-local-smoke` 使用固定合成 ACP Provider 在可丢弃 Worktree 写文件、
运行测试并检查公开事实，还验证真实 Provider opt-in gate。普通 `npm run ci` 包含它；
不会启动真实 Copilot、读取真实凭据或访问模型网络。

真实验证必须在理解本地工具权限后显式运行：

```text
npm run smoke:copilot -- --allow-real-provider
```

未传该参数时，在环境读取、Git、临时存储和 Provider 启动之前拒绝。该命令可能使用
网络、Provider 凭据、用户自定义指令和 MCP；不属于普通 CI。它只提供合成仓库，要求
创建 `native-result.txt` 并执行 `node --test synthetic.test.cjs`，最终由本地断言确认
文件、测试、Run 状态和 Tool 事实。每次 Provider attempt 最多 120 秒。
正常停止后清除 Torsor 临时内容与数据库，不打印 Provider 原文。停止无法确认时保留
隔离目录并报错，需要在本地确认停止后处理；不冒险删除可能仍有 Writer 的目录。
Provider 自己的全局 Session/日志和外部副作用不受此清理控制。

参见[规范](specs/trusted-local-provider-policy.zh-cn.md)和
[Runtime 实现参考](../packages/agent-runtime/README.md)。跨重启自动解除隔离、多 Host、
容器/VM、任意 cwd 和完整 permission UI 不在本次范围。
