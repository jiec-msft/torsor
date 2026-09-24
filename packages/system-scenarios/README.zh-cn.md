# `@torsor/system-scenarios`

> 简体中文（主要版本） | [English](README.md)

快速、确定性的 Torsor 系统行为测试。真实 Provider capability bridge →
AgentRuntime → 临时 SQLite → loopback HTTP/SSE → WebController，
无模型、互联网或浏览器。配对[规格](../../docs/specs/system-scenarios.zh-cn.md)
定义范围与 `SS-*` 追踪；独立 ACP conformance 包不受影响。

## 使用

从仓库根目录安装并准备一次：

```powershell
npm ci
npm run build:system-scenarios
npm run test:system-scenarios
npm run repeat:system-scenarios -- 5
```

重复命令每轮启动新的 Node/Vitest 进程，报告测试计数、总时间及每个场景耗时，
并检查生成状态未改变。构建时间与场景运行时间分开。CI 在 Ubuntu/Windows
重复三次；`npm run ci` 也包含场景包的 typecheck/build/test。

## 小型 TypeScript 接口

```ts
import { runSystemScenario } from "@torsor/system-scenarios";

await runSystemScenario(async (system) => {
  system.provider(async ({ cause, capabilities }) => {
    if (cause.type === "attention") {
      await capabilities.createRunFromAttention();
    } else {
      await capabilities.appendActivity("assistant_delta", { text: "Synthetic progress." });
      await capabilities.complete({ finalReply: { body: "Synthetic result." } });
    }
  });
  const threadId = await system.startThread();
  await system.drain();
  await system.web.loadThread(threadId);
  await system.sync();
});
```

在本包的 Vitest 配置下运行测试；`test/setup.ts` 冻结并检查应用 timer，
同时控制 `performance.now()`，避免磁盘延迟消耗虚拟执行预算。
`gate().entered/wait()/release()` 控制 Provider 次序，`clock.advance(ms)`
只推进 Kernel/Runtime 逻辑时钟。`sync()` 捕获至调用时的持久 SSE 高水位再批量
投递；`advanceUntil(predicate)` 在公开持久条件成立时停止 Runtime pass，
不必排空与该场景无关的后续执行。
`disconnect()` 与 `sync("reverse-duplicate")` 验证真实通知的重连/乱序。
普通 `kernel`/`web` 端口用于公开命令和投影，不暴露数据库表或 app 私有实现。
`http.loseNextResponse(path)` 在服务器处理后丢弃响应；
`http.failNextRead(path)` 注入明确读取失败。未消费故障控制使清理失败。
`reopen()` 返回全新实例；必须显式重新配置 Provider，原实例统一拥有后续清理。
`crashDuringReport()` 在真实报告字节落盘后、descriptor 提交前退出；
另一个真实 child 边界是下面的固定 Worktree probe，不提供任意 command/path API。

## Lease-backed Worktree 场景

给 `runSystemScenario` 传入第二个参数 `{ worktrees: "fixed" }` 或
`{ worktrees: "scripted" }`，启用真实公开 `LocalWorktreeExecutor`。
`system.worktrees.register(runId)` 创建隔离配置下的合成 detached Git fixture，
返回 opaque ID；Provider 只调用 `context.worktree.probe(id)`，不获取路径或命令。
`fixed` 使用生产固定 Node child；`scripted` 仅替换公开 options 中的 trusted
process driver，不替换 Runtime、Kernel、SQLite 或网络投影。

`system.worktrees.processes.holdNext()` 返回下次 child 的 readiness Promise，
其 `emitResult()`、`confirmStop()` 和 stop/force 计数分别控制/观察结果与物理证据。
未 held 的脚本正常返回固定 digest 并确认停止。脚本 lease 为 1000 ms，
stop/force grace 各 10 ms；测试显式推进 Vitest timer 和独立 Kernel 时钟。
这些是确定性调度值，不是 wall-clock 性能断言。
`system.worktrees.executor` 保留生产公开 lifecycle 接口。

`fork()` 在同一数据库打开全新的 Kernel/Runtime/HTTP/Web composition，先恢复
executor 再开放 HTTP；原实例可仍持有旧 process handle。每个 composition
必须重新设置 Provider。`reopen()` 则先关闭旧实例；两者均由最初目录所有者清理，
不能删除仍共享的目录。`expectRuntimeFailure(work, assertion)` 只消费断言确认的
同一个已跟踪错误，其他 Provider assertion 仍使场景失败。

## 生产路径 trusted-local 场景

`runTrustedLocalScenario` 组合真实 `createLocalRuntimeHost`、Runtime、
`CopilotAcpAdapter`、`LocalWorktreeExecutor`、SQLite、HTTP/SSE、WebController
和 Windows Job Object/Linux process-group owner。固定合成 ACP Provider 只在一次性
Git Worktree 中写入 `native-result.txt`、执行固定 Node test，或创建用于
cancel/fence 的实际 descendant；不读取真实 Copilot 凭据、用户环境或网络。

三个 SS-3.10 场景分别验证正常完成、Windows 原 owner 确认 `ForceTerminated` 或
Linux 无完整证据时的 `Uncertain` quarantine/recovery，
以及独立 fencing 后 Human cancel 的 `provider_worktree_authority_lost` 和
delivery 不误确认。PID fixture 仅用于独立证明本场景拥有的 Provider/descendant
已消失。停止未确认时清理保留明确临时目录并失败，不会删除可能仍在写入的 Worktree。

## 16 个场景

| 规格 | 场景 |
|---|---|
| SS-3.2 | Human Thread → Run → 有序活动 → 最终 Reply/完成，SSE 驱动 Web |
| SS-3.3 | 响应丢失、同身份重试、payload 冲突、只读恢复 |
| SS-3.4 | 302 条活动、100 条分页、有限补读、重复/乱序重放、保留历史 |
| SS-3.5 | depth 4/5；真实默认 cap 50，Waiting 占位、终态释放后重试 |
| SS-3.6 | SHA-256、独立 descriptor、兄弟 Run scope、固化/重开/下载 |
| SS-3.7 | 真正进程退出、未提交报告不可见、持久 checkpoint 与新 Runtime 续跑 |
| SS-3.8.1 | 固定 child 正常停止、generation/fencing、可信报告及 SSE completion |
| SS-3.8.2 | 精确 expiry、所有旧 Writer publication 拒绝、未知停止隔离、晚到 close reconciliation |
| SS-3.8.3 | 独立 composition 并发接管、独立目录、新 Run generation、晚到旧输出拒绝、重复恢复 |
| SS-3.10.1 | 真实 Host/ACP/native owner 正常 edit/test、receipt、Tool activity、SSE/Web completion |
| SS-3.10.2 | Human cancel、真实 stubborn process tree、Windows 原 owner 确认 `ForceTerminated`；Linux 无完整证据则 `Uncertain` 并隔离；fresh-executor recovery |
| SS-3.10.3 | 精确 live-authority fence、Human cancel、authority-lost、无 false delivery acknowledgement |
| SS-2.4 | 无新事件时仍完成真实 SSE handshake；初始连接、重连与重开不重发命令 |
| SS-2.2/SS-3.8.4 | 显式 Runtime 失败断言不掩盖独立 Provider assertion |
| SS-4.2 | 清理成功路径及未知活跃 handle 的失败路径 |

完整 16 场景本地目标为运行阶段少于 20 秒；普通 in-process 场景目标少于 300 ms。
真实 50-Run cap、大分页和 Git/Worktree 边界有大量持久事务，是较慢的例外；不减小产品默认
阈值、不关闭 SQLite 持久性来伪造速度。重复命令输出实际值而非紧 wall-clock 断言。
外层进程使用真实单调时钟，hosted runner 可能更慢；CI 日志保留每轮实际值。

SS-3.8 与 SS-3.10 对齐 schema 19（保留 schema 18 execution receipt，且拒绝
schema 18 及更早布局）：前者保留固定 deterministic tracer，后者覆盖
受支持 trusted-local 生产路径的合成 ACP edit/test 与实际 owned process tree。
本包不是 hostile-code sandbox，不验证真实模型质量或外部副作用 exactly-once，
也不替代最终 exact-head 独立审查。
