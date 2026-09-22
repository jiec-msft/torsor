# Torsor System Scenario Harness

> English | [简体中文](system-scenarios.zh-cn.md)

## 1. Scope and dependencies

**SS-1.1** This tool tests Torsor system behavior caused by deterministic Providers:

```text
Scenario -> Scripted Provider -> Agent Runtime -> Kernel/SQLite
         -> HTTP/SSE -> WebController -> Assertions
```

Use the real Runtime, temporary file-backed SQLite, production HTTP/SSE and
browserless WebController. `@torsor/system-scenarios` is a test-only composition
package, never a production dependency. `@torsor/acp-conformance` independently
tests ACP v1; neither harness depends on the other, and its strict protocol DSL
must not become a system-test DSL.

**SS-1.2** Reuse public `TorsorKernel.open`, `AgentRuntime` and
`createTorsorHttpService` shared-Kernel embedding APIs. The web package exposes
`@torsor/web/controller`: only the headless controller, options, state and event
source port, not React/App internals. Default browser behavior is unchanged.
Tests must not deep-import another package's source/test internals.

## 2. Vocabulary and public interface

**SS-2.1** A Scenario is a TypeScript test citing numbered contracts. Given
establishes synthetic collaboration state; When executes Human commands,
Provider capabilities or scheduler steps; Then reads public Kernel, HTTP and
Web projections. `runSystemScenario(async (system) => { ... })` owns the
lifecycle, without YAML, expression parsing or new domain objects.

**SS-2.2** `system.provider` scripts real `ProviderExecutionContext` behavior,
changing domain state only through capabilities. Script errors must fail the
scenario, not disappear into Runtime-recorded Provider failure.
`system.drain()` consumes bounded durable work; `system.sync()` advances Web
projections from real SSE bytes. `system.advanceUntil(predicate)` advances one
Runtime pass at a time until a public durable condition holds; quiescence
without that condition fails, avoiding work unrelated to the assertion.
Assertions await observable conditions, not
arrival timing. `system.reopen()` discards Runtime/Controller/Provider instances
and reopens the same SQLite/Artifact root, retaining only durable state and
explicit scenario input.

**SS-2.3** The Kernel clock advances explicitly; Provider gates have arrival and
release signals. The runner controls application timers; correctness cannot
depend on an unadvanced timer. SSE reconnect replays from an explicit cursor.
Transport may pause, duplicate or reverse captured real notifications, never
fabricate Kernel facts. Activity catch-up has a finite ceiling and pages of at
most 100. Arbitrary sleeps, real models, internet, browsers and real credentials
are forbidden.
`sync()` captures through the durable high-water mark at call time, then releases
that finite SSE prefix as one batch; network chunking must not determine
projection refresh counts. Captured disconnected prefixes may be released in
reverse/duplicate order.

## 3. Initial catalog and derivation

**SS-3.1** Derive each rule along normal path, boundary, retry/replay and
interruption/concurrency dimensions. Select critical representatives in this
slice rather than a Cartesian expansion. Add one failing public-behavior test,
implement minimally, run that tracer, then add the next test. The following
numbers trace implementation and tests; domain semantics come from the paired
[MVP specification](../prototype/001-overview.md).

| Number | Representative scenario | MVP source |
|---|---|---|
| SS-3.2 | Human creates Thread; Runtime Attention decision creates Run; Provider emits ordered activity and explicitly publishes final Reply/completion. Durable Run, input disposition, ordered Timeline and Thread Reply have no duplicates; SSE drives visible Web state | 17–21, 37, 44.1 |
| SS-3.3 | Committed Send-to-Run loses response; freeze original key/payload/revision, retry creates only one input/Message. Changed payload with the same key conflicts; recovery reads never resend commands | 19.2, 21.2, 44.2 |
| SS-3.4 | More than 100 activity facts, pagination, bounded reconnect catch-up and duplicate/out-of-order replay lose/duplicate nothing and retain loaded history | 26, 37.2–37.3 |
| SS-3.5 | Depth 4 admitted, 5 rejected; root nonterminal cap 50 includes Waiting and releases only on terminal commit. Retry after release admits once with unchanged provenance | 25.1–25.2 |
| SS-3.6 | Trusted report digest, finalization, reopen and retry; equal bytes in different Runs retain independent descriptors; parent/child or sibling isolation, indistinguishable absent/out-of-scope reads | 21.3–21.5, 23 |
| SS-3.7 | Crash/reopen preserves committed facts, not uncommitted work; a fresh Runtime continues from durable inputs without long-lived Agent memory | 20–21 |
| SS-3.8 | After lease execution lands on main: old-generation/fenced/expired live processes cannot publish mutations, descriptors, success activity or completion; new generation wins, late output is rejected/quarantined, restart/reconciliation is deterministic | 21.5, 22, 24, 38 |

**SS-3.9** Ordinary assertions use public projections. Only dedicated
schema/crash boundaries may inspect database bytes/layout or terminate inside a
transaction. Ordinary Provider scripts do not mock Kernel. Physical execution
permits only the approved fixed controlled tracer: no general ACP shell/write,
Human Terminal, arbitrary host commands, marketplace or broad filesystem APIs.

## 4. Speed, cleanup and evidence

**SS-4.1** Target the current-main package below 10 seconds locally and individual
in-process scenarios normally below 300 ms. These are measured goals, not brittle
per-test wall-clock assertions. Reuse a test process with isolated persistent
directories; only a tiny crash/physical boundary subset may spawn children.
Provide a fresh-Node-process repeat command reporting per-round elapsed time
and test counts, visible in CI.

**SS-4.2** Even on assertion failure, close Controller, SSE, HTTP, Runtime work,
Provider gates, SQLite and owned temporary directories. Cleanup failures fail.
Unconsumed script errors, unhandled rejections, leftover timers/handles/children
or generated state fail. Clean only explicitly owned paths/processes, never
scan/terminate unrelated processes. Do not force successful exit to hide leaks;
timeouts are failure watchdogs, not scheduling.
Performance goals are not hosted-runner failure deadlines: use a 60-second
per-test watchdog, 30 seconds for cleanup hooks, and a 120-second outer
fresh-process watchdog. Slow disks still report actual timings and whether
the target was met, without weakening domain assertions or SQLite durability.
Vitest fake timers count application timers; `async_hooks` tracks native
TCP/pipe/process/timer resources. The sole known exception is Node's
process-global HTTP Date-header cache timer, which server.close cannot cancel;
the exception does not include application timers.

## 5. Public safety and deferrals

**SS-5.1** Names, bodies, reports, credentials and Git fixtures are synthetic.
Generate loopback credentials in memory per run; never read real login config,
environment secrets, user workspaces or external services. Public evidence
contains only test names/counts/times and public commit/CI references, not
temporary absolute paths, tokens, process environments or non-public material.

**SS-5.2** Defer real-model/browser tests, complete ACP coverage, fuzzing, the full
Cartesian catalog, multi-host operation, a general virtual-time framework,
power-loss guarantees and cross-process draft recovery. This is not an OS
sandbox and does not prove LLM understanding or generic exactly-once delivery.
