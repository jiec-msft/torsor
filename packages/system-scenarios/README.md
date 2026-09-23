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
audits application timers and controls `performance.now()`, preventing disk
delays from consuming virtual execution budgets. `gate().entered/wait()/release()` controls Provider
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
`crashDuringReport()` exits after real report bytes are durable but before
descriptor commit. The other real child boundary is the fixed Worktree probe
below; there is no arbitrary command/path API.

## Lease-backed Worktree scenarios

Pass `{ worktrees: "fixed" }` or `{ worktrees: "scripted" }` as the second
`runSystemScenario` argument to enable the real public `LocalWorktreeExecutor`.
`system.worktrees.register(runId)` provisions a synthetic detached Git fixture
with isolated configuration and returns an opaque ID. Providers call only
`context.worktree.probe(id)`, without paths or commands. `fixed` uses the production
fixed Node child; `scripted` replaces only the public options' trusted process
driver, never Runtime, Kernel, SQLite or network projections.

`system.worktrees.processes.holdNext()` returns the next child's readiness Promise.
Its `emitResult()`, `confirmStop()` and stop/force counters independently control
or observe results and physical evidence. Unheld scripts return the fixed digest
and confirm normal stop. Scripted leases last 1000 ms, with 10 ms stop/force grace
each; tests explicitly advance Vitest timers and the separate Kernel clock.
These are deterministic scheduling values, not wall-clock performance assertions.
`system.worktrees.executor` retains the production public lifecycle interface.

`fork()` opens a fresh Kernel/Runtime/HTTP/Web composition on the same database,
recovering the executor before opening HTTP; the original may still retain an
old process handle. Each composition requires explicit Provider configuration.
`reopen()` closes the previous instance first. The original directory owner
cleans both forms without removing still-shared directories.
`expectRuntimeFailure(work, assertion)` consumes only the same tracked error
confirmed by the assertion; other Provider assertions still fail the scenario.

## Initial catalog

| Specification | Scenario |
|---|---|
| SS-3.2 | Human Thread → Run → ordered activity → final Reply/completion, SSE-driven Web |
| SS-3.3 | Response loss, same-identity retry, payload conflict, read-only recovery |
| SS-3.4 | 302 facts, 100-item pages, finite catch-up, duplicate/reversed replay, retained history |
| SS-3.5 | Depth 4/5; real default cap 50, Waiting occupancy, retry after terminal release |
| SS-3.6 | SHA-256, independent descriptors, sibling Run scope, finalization/reopen/download |
| SS-3.7 | Real process exit, invisible uncommitted report, durable checkpoint and fresh Runtime continuation |
| SS-3.8.1 | Fixed-child normal stop, generation/fencing, trusted report and SSE completion |
| SS-3.8.2 | Exact expiry, denial of all stale Writer publication, unknown-stop quarantine, late-close reconciliation |
| SS-3.8.3 | Concurrent independent composition, isolated directory, new Run generation, rejected late output, repeated recovery |
| SS-2.4 | Real SSE handshake without new events; initial connection, reconnect and reopen never resend commands |
| SS-2.2/SS-3.8.4 | Explicit Runtime failure assertions cannot hide a distinct Provider assertion |
| SS-4.2 | Successful cleanup and failure on an unknown live handle |

Target the run phase below 10 seconds locally and ordinary in-process scenarios
below 300 ms. The real 50-Run cap, large pagination and Git/Worktree boundaries perform many
durable transactions and are slower boundary exceptions; do not lower product
defaults or disable SQLite durability to manufacture speed. Repeats report
measurements rather than tight wall-clock assertions.
A representative Windows/Node 24 three-round fresh-process run passed **13/13**
each round in **9.151–9.548 seconds**, excluding builds; Worktree scenarios took
about **0.56–1.18 seconds**. The outer process measures real monotonic time.
Hosted runners may be slower; CI logs retain each actual measurement.

SS-3.8 now integrates schema-16 fixed `write-probe-v1`. Trusted-local real Agent
workloads, general shell/write and cross-restart process-tree isolation remain
unintegrated. Fake/fixed-process scenarios do not replace their production
acceptance or the eventual independent exact-head review.
