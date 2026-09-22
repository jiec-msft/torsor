# `@torsor/system-scenarios`

> English | [简体中文](README.zh-cn.md)

Fast deterministic Torsor system tests: real Provider capability bridge →
AgentRuntime → temporary SQLite → loopback HTTP/SSE → WebController, without
models, internet or browsers. The paired [specification](../../docs/specs/system-scenarios.md)
defines scope and `SS-*` traceability. Independent ACP conformance is unchanged.

## Usage

Install and prepare once from the repository root:

```powershell
npm ci
npm run build:system-scenarios
npm run test:system-scenarios
npm run repeat:system-scenarios -- 5
```

Each repeat starts a fresh Node/Vitest process, reports counts, total and
per-scenario elapsed times, and checks generated state is unchanged. Build time
is separate from scenario time. CI repeats three times on Ubuntu/Windows;
`npm run ci` also includes package typecheck/build/test.

## Small TypeScript interface

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

Run tests with this package's Vitest configuration; `test/setup.ts` freezes and
audits application timers. `gate().entered/wait()/release()` controls Provider
ordering; `clock.advance(ms)` advances only the Kernel/Runtime logical clock.
`sync()` captures the durable SSE high-water mark at call time and releases a
batch. `advanceUntil(predicate)` stops Runtime passes at a public durable
condition without draining unrelated execution. `disconnect()` and
`sync("reverse-duplicate")` exercise reconnect and
out-of-order real notifications. Ordinary `kernel`/`web` ports expose public
commands/projections, not database tables or app internals.
`http.loseNextResponse(path)` drops a response after server processing;
`http.failNextRead(path)` injects a definite read failure. Unconsumed faults
fail cleanup. `reopen()` returns a fresh instance requiring explicit Provider
configuration; the original instance retains cleanup ownership.
The sole child boundary, `crashDuringReport()`, exits after real report bytes
are durable but before descriptor commit; there is no arbitrary command/path API.

## Initial catalog

| Specification | Scenario |
|---|---|
| SS-3.2 | Human Thread → Run → ordered activity → final Reply/completion, SSE-driven Web |
| SS-3.3 | Response loss, same-identity retry, payload conflict, read-only recovery |
| SS-3.4 | 302 facts, 100-item pages, finite catch-up, duplicate/reversed replay, retained history |
| SS-3.5 | Depth 4/5; real default cap 50, Waiting occupancy, retry after terminal release |
| SS-3.6 | SHA-256, independent descriptors, sibling Run scope, finalization/reopen/download |
| SS-3.7 | Real process exit, invisible uncommitted report, durable checkpoint and fresh Runtime continuation |
| SS-4.2 | Successful cleanup and failure on an unknown live handle |

Target the run phase below 10 seconds locally and ordinary in-process scenarios
below 300 ms. The real 50-Run cap and large pagination catalog perform many
durable transactions and are slower boundary exceptions; do not lower product
defaults or disable SQLite durability to manufacture speed. Repeats report
measurements rather than tight wall-clock assertions. Add lease execution
`SS-3.8` only after its public interfaces are integrated into main.
