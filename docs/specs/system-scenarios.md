# Torsor System Scenario Harness

> English | [简体中文](system-scenarios.zh-cn.md)

## 1. Scope and dependencies

**SS-1.1** This tool tests Torsor system behavior caused by deterministic Providers:

```text
Scenario -> Scripted Provider -> Agent Runtime -> Kernel/SQLite
         -> HTTP/SSE -> WebController -> Assertions

Scenario -> Local Runtime Host -> trusted-local ACP Adapter
         -> LocalWorktreeExecutor -> native process-tree owner
         -> Kernel/SQLite -> HTTP/SSE -> WebController -> Assertions
```

Use the real Runtime, temporary file-backed SQLite, production HTTP/SSE and
browserless WebController. `@torsor/system-scenarios` is a test-only composition
package, never a production dependency. `@torsor/acp-conformance` independently
tests ACP v1; neither harness depends on the other, and its strict protocol DSL
must not become a system-test DSL.

**SS-1.2** Reuse public `TorsorKernel.open`, `AgentRuntime`,
`createTorsorHttpService`, `createLocalRuntimeHost`, `CopilotAcpAdapter` and
`LocalWorktreeExecutor` APIs. The web package exposes
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
The runner also controls `performance.now()` alongside application timers:
disk/CPU delays cannot consume a logical scenario's execution budget. Advance
the Kernel date clock separately. Fresh-process benchmarks use the real monotonic
clock outside the test process, never virtual time as speed evidence.

**SS-2.4** With no new facts, on initial connection or after reopening at the
high-water cursor, `sync()` still completes a real authenticated SSE handshake,
notifies Web `onopen`, and awaits reconnect reads and invalidation retries.
Never fabricate events, resend commands, or leave Web `connecting`/`reconnecting`.

**SS-2.5** `runTrustedLocalScenario` uses the real Host/Runtime/Adapter/Worktree
composition and platform-native process-tree owner. Its Provider is a fixed
synthetic ACP child owned by this package and uses only a disposable Git fixture;
it never reads user environment, login configuration, real credentials or the
network. Scenarios may observe public durable projections, public HTTP/SSE/Web
state, and the PID fixture written by that synthetic child. A mock owner, fake
Kernel or precomputed success result must not replace the production path.

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
| SS-3.8 | Public lease execution retained by schema 19: old-generation/fenced/expired live processes cannot publish mutations, descriptors, success activity or completion; new generation wins, late output is rejected/quarantined, restart/reconciliation is deterministic; schema 18 and older layouts are rejected before writes | 21.5, 22, 24, 38 |
| SS-3.10 | Production-path trusted-local lifecycle: normal completion, Human cancellation with unknown stop/quarantine/recovery, and independent fencing followed by cancellation without false delivery acknowledgement | 20.2, 22, 24, 27, 31.1, 45 |

**SS-3.8.1** Use public `LocalWorktreeExecutor`, with Human/Runtime Run creation,
to execute the fixed `write-probe-v1` child in a synthetic detached Git worktree.
Publish a trusted report, activity, Reply and completion only after the fixed
digest, original-handle normal stop and current Writer authority all hold.
HTTP/SSE/Web show the same committed result. New lease generation/fencing rejects
old tokens; normal stop retains the publication window until settlement releases it.

**SS-3.8.2** Use the public executor options' trusted process driver to schedule
only fixed-probe result, stop request, force request and original-handle close.
Advance the logical clock to exact expiry and explicitly advance runner-controlled
monitor/grace timers, without sleeps. While the old process remains live, deny
activity (including idempotent replay), Reply, Artifact finalization and success
settlement. Expiry, stop request and force request do not prove stop. Missing close
means `Uncertain`/quarantine and denied same-directory acquisition. Late original-
handle close may reconcile physical state but never revive the old Writer.
Runtime failure assertions match only the stable allowlisted diagnostic code and
generic summary defined by section 20.2, never raw process errors, paths, commands,
environments, or Provider text.

**SS-3.8.3** Open an independent Kernel/Runtime/HTTP/Web composition on the same
SQLite database, with controlled interleaving representing executor restart and
concurrent recovery; do not mock Kernel or reuse Agent memory. The new executor
quarantines the old incarnation's unstopped intent. A new authorized Run Activation
may complete in a separate directory provisioned from the known synthetic base.
Old output cannot contaminate the new result; late old-receipt stop cannot modify
the new execution. Reopen and repeated recovery retain committed facts without
duplicate Provider success. This does not claim real power-loss or cross-restart
OS containment coverage.

**SS-3.8.4** The optional Worktree mode of `runSystemScenario` supplies only fixed
synthetic Git provisioning, the public executor and narrow process controls.
Git uses isolated configuration, empty hooks, fixed identity/date, explicit argument
vectors and bounded watchdogs. Each scenario owns its directories; same-database
compositions share directory ownership and close in dependency order. Explicitly
expected Runtime failures require individual assertions and must not hide other
script errors. Cleanup releases held result/close controls, stops executors and
cancels monitor/grace/retry timers before closing SQLite, including failure paths.

**SS-3.9** Ordinary assertions use public projections. Only dedicated
schema/crash boundaries may inspect database bytes/layout or terminate inside a
transaction. Ordinary Provider scripts do not mock Kernel. Physical execution
permits only the approved fixed controlled tracer and the SS-3.10 synthetic
trusted-local ACP fixture: no Human Terminal, arbitrary external host commands,
marketplace or broad filesystem APIs.

**SS-3.10.1** The normal trusted-local scenario must pass through
`createLocalRuntimeHost`, the real Runtime, `CopilotAcpAdapter`,
`LocalWorktreeExecutor`, and the platform-native owner, actually writing a file
and running a fixed Node test in the assigned Worktree. Final evidence must
include `StopConfirmed`, an execution receipt bound to the correct
ProviderAttempt/policy/permission mode, Completed Run and ProviderAttempt,
public allowlisted Tool activity, consistent HTTP/SSE/Web projections, and
acknowledged delivery. Raw tool ids, commands, paths, payloads, session ids and
private Provider text must not enter public evidence.

**SS-3.10.2** A stubborn synthetic Provider must create a real descendant.
Human cancellation uses very short stop/force grace to produce `Uncertain`
without original-handle close evidence. The Run is Cancelled, ProviderAttempt
Unknown, and the Worktree remains quarantined. The scenario
independently confirms both Provider and descendant PIDs disappear. Before that
confirmation, same-directory acquisition must fail with `DomainBusy`. A fresh
executor running `recover()` against the same SQLite/root must not clear
`Uncertain`, quarantine, or replacement denial.

**SS-3.10.3** An independent Runtime must fence using the exact live Writer
authority captured for the execution, followed by Human cancellation. The real
owner stops the complete process tree; the Host must propagate stable
`provider_worktree_authority_lost`/`Unknown`, never success or ordinary
cancellation. After reopen, the Run is Cancelled, ProviderAttempt Unknown,
physical stop is confirmed, and delivery that triggered the execution remains
unacknowledged. The scenario may explicitly resolve quarantine through the
public token/revision/fencing contract only after independent PID-disappearance
evidence.

**SS-3.10.4** Trusted-local cleanup closes any recovery executor/Kernel first,
then online Controller/SSE/HTTP/Host, and independently waits for recorded
process-tree PIDs to disappear. It may delete the disposable directory only
when the durable stop receipt is `StopConfirmed`/`ForceTerminated`, or the
scenario independently confirmed every owned PID disappeared. A failure before
physical stop confirmation must fail cleanup and preserve the explicit
directory, never delete a Worktree that a Writer may still use.

## 4. Speed, cleanup and evidence

**SS-4.1** Target the complete current-main 16-scenario package below 20 seconds locally and individual
in-process scenarios normally below 300 ms. These are measured goals, not brittle
per-test wall-clock assertions. Reuse a test process with isolated persistent
directories; only a tiny crash/physical boundary subset may spawn children.
Real trusted-local Host/ACP/Git/process-tree scenarios are slower boundary exceptions.
Provide a fresh-Node-process repeat command reporting per-round elapsed time
and test counts, visible in CI.

**SS-4.2** Even on assertion failure, close Controller, SSE, HTTP, Runtime work,
Provider gates, SQLite and owned temporary directories. Cleanup failures fail.
Unconsumed script errors, unhandled rejections, leftover timers/handles/children
or generated state fail. Clean only explicitly owned paths/processes, never
scan/terminate unrelated processes. Do not force successful exit to hide leaks;
timeouts are failure watchdogs, not scheduling.
Preserve the directory and fail cleanup whenever physical Writer stop is unconfirmed.
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

**SS-5.2** Defer real external-model/browser tests, complete ACP coverage, fuzzing, the full
Cartesian catalog, distributed multi-host operation, a general virtual-time framework,
power-loss guarantees and cross-process draft recovery. This is not an OS
sandbox and does not prove LLM understanding or generic exactly-once delivery.
SS-3.10 covers synthetic ACP write/test and an actual owned process-tree
lifecycle on the supported trusted-local path. It does not claim defense against
a malicious local owner, daemons deliberately escaping the owned tree, arbitrary
third-party Provider behavior, or exactly-once external MCP/API effects. Those
boundaries follow Core section 31.1 and do not replace final exact-head
independent review.
