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

在本包的 Vitest 配置下运行测试；`test/setup.ts` 冻结并检查应用 timer。
`gate().entered/wait()/release()` 控制 Provider 次序，`clock.advance(ms)`
只推进 Kernel/Runtime 逻辑时钟。`sync()` 捕获至调用时的持久 SSE 高水位再批量
投递；`advanceUntil(predicate)` 在公开持久条件成立时停止 Runtime pass，
不必排空与该场景无关的后续执行。
`disconnect()` 与 `sync("reverse-duplicate")` 验证真实通知的重连/乱序。
普通 `kernel`/`web` 端口用于公开命令和投影，不暴露数据库表或 app 私有实现。
`http.loseNextResponse(path)` 在服务器处理后丢弃响应；
`http.failNextRead(path)` 注入明确读取失败。未消费故障控制使清理失败。
`reopen()` 返回全新实例；必须显式重新配置 Provider，原实例统一拥有后续清理。
唯一 child 边界 `crashDuringReport()` 在真实报告字节落盘后、descriptor 提交前
退出；不提供任意 command/path API。

## 首批场景

| 规格 | 场景 |
|---|---|
| SS-3.2 | Human Thread → Run → 有序活动 → 最终 Reply/完成，SSE 驱动 Web |
| SS-3.3 | 响应丢失、同身份重试、payload 冲突、只读恢复 |
| SS-3.4 | 302 条活动、100 条分页、有限补读、重复/乱序重放、保留历史 |
| SS-3.5 | depth 4/5；真实默认 cap 50，Waiting 占位、终态释放后重试 |
| SS-3.6 | SHA-256、独立 descriptor、兄弟 Run scope、固化/重开/下载 |
| SS-3.7 | 真正进程退出、未提交报告不可见、持久 checkpoint 与新 Runtime 续跑 |
| SS-4.2 | 清理成功路径及未知活跃 handle 的失败路径 |

本地目标为运行阶段少于 10 秒；普通 in-process 场景目标少于 300 ms。
真实 50-Run cap 和大分页目录有大量持久事务，是较慢的边界例外；不减小产品默认
阈值、不关闭 SQLite 持久性来伪造速度。重复命令输出实际值而非紧 wall-clock 断言。
lease execution 场景 `SS-3.8` 仅在相应公开 main 接口集成后添加。
