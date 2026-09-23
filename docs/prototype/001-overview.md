# Deriving Torsor's Minimum Kernel

> [简体中文（主要版本）](001-overview.zh-cn.md) | English

> Status: working notes
>
> Updated: 2026-09-22
>
> Purpose: record the current design consensus, unresolved questions, and the entry point for the next derivation round.
>
> Note: this document records the current discussion outcome; it is not a final product specification.
>
> **Reading note: sections 1-13 preserve the derivation history. Section 14 onward is the current authoritative MVP kernel candidate. If they conflict, section 14 and later sections take precedence.**

The accompanying public interaction prototype is in [`mvp-0.1/`](mvp-0.1/). Its scenario screenshots and verification index are in [`mvp-0.1/README.md`](mvp-0.1/README.md).

## 1. Product goal

Torsor uses the Human-familiar language of Channel, Thread, Message, and Mention without reproducing Human serial execution, latency, or attention bottlenecks.

```text
Human-shaped interface
Agent-native execution

As easy to collaborate with as a Human
But concurrent, responsive, and deliverable at Agent scale
```

An Agent is a stable identity, configuration, and capability definition, not one resident process. One Agent may have many concurrent execution instances across Threads and Runs.

## 2. Confirmed base relationships

1. A Project may have multiple Channels.
2. A Channel belongs to exactly one Project.
3. A Channel contains Messages.
4. A Root Message may have Replies.
5. A Thread has one level; every Reply points directly to the Root Message.
6. Humans and Agents may send Messages, Replies, and Mentions.
7. A Message is not an Agent Run.
8. A Mention may create Attention but need not create a Run automatically.
9. An Agent creates and manages Runs through Torsor capabilities.
10. A Run works inside the Project bound to its Channel.
11. A writable Run uses an exclusive Worktree.
12. Different Runs must not write the same Worktree concurrently.
13. One Agent may own multiple Runs concurrently.
14. One Thread may contain multiple Runs owned by the same Agent.
15. A Thread is public collaboration space, not the only execution Session.

## 3. Current minimum objects

### 3.1 Project

Provides code, configuration, and execution boundaries.

### 3.2 Channel

Belongs to one Project and carries public collaboration.

### 3.3 Message

A durable Human or Agent expression. A Message is either a Root Message or a one-level Reply.

An Agent Message must record real provenance, for example:

```text
author_agent_id
caused_by_attention_id
caused_by_run_id
```

The exact fields may change, but provenance cannot be reduced to an untraceable Agent display name.

### 3.4 Agent

A stable identity and configuration, not one process or Provider Session. One Agent may instantiate many executors:

```text
Agent Fixer
├─ Instance A: handles Thread 1
├─ Instance B: handles Thread 2
├─ Instance C: handles new Attention in Thread 1
└─ Instance D: performs an independent Review
```

### 3.5 Attention

A durable fact that a Message requires a decision from an Agent. Attention activates an Agent instance but does not itself create a Run.

During Attention handling, an Agent instance may call capabilities such as:

```text
create_run
list_runs
get_run
send_input_to_run
pause_run
cancel_run
resume_run
reply
mention
publish_artifact
ignore_attention
```

The capability names are not final.

### 3.6 Run

A durable line of work created and managed by an Agent. A Run may span many Agent activations, wait for a Human or external condition, produce Messages and Artifacts, create child/Fork/Successor/Replacement Runs, and be paused, cancelled, or completed.

A Run is not one LLM call. After entering a terminal state such as `Completed`, `Failed`, or `Cancelled`, an old instance must not return it to `Running`; later work uses a related new Run.

### 3.7 Worktree Lease

Protects exclusive write access:

```text
one Worktree
→ at most one valid Writer at a time
```

Multiple Agent instances may read or manage one Run, but they must not write the same Worktree concurrently.

### 3.8 Artifact

An immutable, durable result reference produced by a Run, such as a commit, patch, branch ref, investigation report, Review conclusion, or test log. It must be traceable to its source Run and base revision.

## 4. Agent Instance and Activation

Agent Instance or Activation is a runtime concept and need not become a long-lived user-facing domain object. Protocol and audit data must still include:

```text
activation_id
agent_id
caused_by_attention_id or caused_by_run_id
capability scope
observed revision / event cursor
```

Hidden LLM context is not shared truth. Other instances may rely only on durable Torsor Messages, Runs, Artifacts, state, and events.

## 5. Responsibility boundaries

### 5.1 Torsor

Torsor stores Project, Channel, Message, Attention, Run, and Artifact facts; provides capabilities; authenticates Human and Agent identities; binds capability calls to server-issued Activation Context; enforces idempotency, Worktree single-writer access, atomic Run transitions, revision checks, provenance, and terminal-state boundaries; exposes Provider capability support; scopes managed external capabilities; persists important external operation identity, idempotency, results, and references; reports failures and conflicts; and preserves Human stop authority.

### 5.2 Agent

The Agent interprets messages, decides whether to continue/Fork/create/replace/ignore work, creates and manages Runs, detects semantic duplication or conflict, coordinates or replaces Runs, synthesizes Artifacts, judges completion from the effective Prompt and context, decides whether to create a PR or wait for CI/merge/deployment, explains outcomes, and asks other Agents or a Human when needed.

### 5.3 Human

The Human need not coordinate every step but retains final control: stop work, change goals, configure Agent Prompt/capabilities/expected results, select candidates, reject coordination conclusions, and decide questions that cannot be automated.

## 6. Conflict classes

### 6.1 Mechanical conflicts

Torsor must prevent concurrent writers in one Worktree, stale Run revisions overwriting new ones, duplicate logical Attention effects, old instances reviving cancelled Runs, and forged Artifact provenance.

```text
idempotency key
entity revision
expected revision
atomic state transition
Worktree Lease
immutable Artifact
```

### 6.2 Execution conflicts

When a stop is requested while a Provider still runs, Torsor distinguishes:

```text
stop requested
provider accepted
stopped gracefully
force terminated
```

It must not assume every Provider supports immediate Interrupt, Steer, Pause, or Resume.

### 6.3 Semantic disagreement

Torsor does not interpret natural language and declare a semantic conflict. It exposes the complete Thread, active Runs, state and provenance, Artifacts and base versions, and message/event order. Agents decide whether to coordinate, verify, or request Human judgment.

## 7. Concurrency principles

### 7.1 Highly parallel by default

Independent Threads, Runs, Worktrees, readers, and provenance-bearing Messages may proceed concurrently, including multiple Runs from the same Agent or in the same Thread.

### 7.2 Local atomic commits

Only a contested resource is serialized:

```text
Attention effect  → idempotency
Run state change  → expected revision
Worktree write    → exclusive lease
Artifact          → immutable provenance
```

This is local concurrency control, not a central Coordinator.

### 7.3 Coordination on demand

An Agent may create an ordinary coordination Run for a complex Thread:

```text
R1: implementation
R2: independent investigation
R3: coordinate disagreement between R1 and R2
```

Lead or coordination is not a mandatory kernel role.

## 8. Provider boundary

Torsor does not depend on how many LLM calls or tools a Provider uses, when it checks input, how it organizes prompts, or whether it has an internal security boundary. It depends only on adapter capabilities such as:

```text
accepts_input_while_running
supports_cancel
supports_resume
supports_session_continuation
supports_graceful_pause
```

If real-time Steer is unsupported, a new Agent instance may still reply immediately, persist later input, create a parallel Run, request a stop, or create a Replacement Run.

## 9. Confirmed invariants

1. A Channel belongs to one Project.
2. Reply and Root Message belong to the same Channel.
3. A Thread has one level.
4. Message is not Run.
5. Mention is not automatic execution.
6. Agent is identity and configuration, not one process.
7. One Agent may have concurrent instances and Runs.
8. One Thread may contain multiple Runs.
9. The same logical Attention effect is idempotent.
10. Run revision increases monotonically.
11. Conflicting state transitions use expected revision.
12. An old instance cannot reactivate a terminal Run.
13. A Message claiming completion does not complete authoritative Run state.
14. One writable Worktree has one Writer at a time.
15. Artifact is immutable and traceable to its source Run.
16. Agent Message records source Attention or Run.
17. Late results may be retained but cannot overwrite newer platform facts.
18. The kernel does not decide semantic disagreements.
19. Agents may create coordination Runs.
20. Humans retain final stop and direction-changing authority.
21. Thread Messages and related events have stable monotonic order.
22. An Agent Reply may record the Thread event cursor it used.
23. Ordinary communication may interleave without global Thread serialization.
24. A freshness-sensitive Reply may require an unchanged Thread; if changed, Torsor does not publish and returns new events.
25. Conditional Message publication does not replace Run revision or Worktree Lease.
26. If Message publication fails, its Mentions must not independently create Attention.

## 10. Concepts not currently required in the kernel

- Generic Task, Decision, Result, or Approval.
- Fixed Lead Agent or central Agent Coordinator.
- Unique Response Authority.
- Global Agent Session or Thread-wide speaking lock.
- A one-Run-per-Agent/Thread limit.
- Long-lived user-facing AgentInstance.
- A universal Interrupt abstraction.
- Automatic natural-language semantic-conflict detection.

## 11. Explicit open questions

1. Whether an ordinary Reply without a new Mention creates Attention.
2. When a Run enters a terminal state after a completion Reply.
3. How long a physical Worktree is retained while Waiting or Paused.
4. Whether Agent configuration updates affect active Runs.
5. Whether completion needs a minimal durable expected outcome beyond the effective Prompt.
6. Uniform delivery semantics when a Provider cannot Steer.
7. Whether Reply explicitly chooses concurrent versus conditional publication or defaults to concurrent.
8. Which events contribute to Thread revision.

Candidate Artifact integration is resolved: there is no central Integration Manager; ordinary Agent Runs decide whether to create PRs, wait for CI, or merge; an ordinary coordination Run may combine candidates; external branch protection, Review, and CI determine acceptance.

## 12. Context freshness

Reading a Thread returns:

```text
observed_through_event = 42
```

A Reply may use `allow_concurrent`, publishing even after the Thread changed while recording its observed cursor, or `require_unchanged`, atomically refusing publication and returning new events when the Thread changed. Progress and independent findings normally allow concurrency; synthesis and direction changes normally require freshness. Torsor does not infer the mode from Message content.

## 13. Next derivation round

Recheck completeness, internal consistency, expressive power, and minimality. Do not introduce Task, Decision, Result, Approval, or a central Coordinator without a concrete story that existing objects cannot express.

## 14. MVP kernel candidate v0.1

This section consolidates the scenarios and supplies implementation boundaries for identity, permission, Attention consumption, Run lifecycle, RunInput, Provider delivery, crash recovery, Worktree fencing, Artifact, synchronization, budgets, and GC.

### 14.1 Overall principles

```text
Human-shaped interface
Agent-native execution
Durable facts
Provider-neutral runtime
Local atomic protection
No central semantic coordinator
```

1. Channel, Thread, Message, and Mention form the Human-familiar interface.
2. Agent is a concurrently instantiable identity, not serialized Human-like attention.
3. Message, Attention, Run, RunInput, and Artifact are durable facts.
4. Provider Session, LLM Turn, and tool loop are not domain truth.
5. Torsor protects identity, permission, idempotency, revision, fencing, provenance, and terminal boundaries.
6. Agents interpret meaning, semantic conflict, and coordination.
7. Atomicity is local to contested resources; there is no global Coordinator.

### 14.2 Authoritative object model

```text
Project
└─ Channel(project_id, visibility scope)
   ├─ Message(thread_root_id, immutable revisions)
   │  └─ Attention(message_revision_id, target_agent_id)
   │
   └─ Run(home_channel_id, owner_agent_id, state, revision)
      ├─ RunInput(message_revision_id, sequence, disposition)
      ├─ Artifact(content_digest, base_revision, provenance)
      ├─ RunLink(kind, related_run_id)
      └─ Worktree(base_revision, generation)
         └─ WriterLease(holder_kind, holder_id, fencing_token)
```

The runtime also persists, without treating them as primary collaboration objects:

```text
ActivationAttempt
ProviderAttempt
CapabilityContext
IdempotencyRecord
OutboxEvent
AuditEvent
```

### 14.3 Core semantics

```text
Message
= public expression

Attention
= an Agent must decide how to handle one Message revision

Run
= a durable line of work managed by an Agent within a Project/Channel scope

RunInput
= the durable fact that an Agent assigned one Message revision to an existing Run

ProviderAttempt
= one actual Provider request, Session delivery, or execution attempt

Artifact
= an immutable result reference produced by a Run
```

The following distinctions are strict:

```text
Message != Attention
Attention != Run
Run != ActivationAttempt
RunInput disposition != Provider delivery
Artifact produced != Artifact integrated
Agent identity != Agent instance
```

## 15. Identity, authentication, and permission

### 15.1 Agent and Activation

1. `Agent` is a stable Principal.
2. Agent Instance has no new long-lived identity.
3. Every Activation uses a short-lived, revocable, scoped Capability Context.
4. It binds at least `agent_id`, `activation_id`, source Attention or Run, Project, home Channel, permitted Runs, and expiry.
5. A Provider never receives long-lived Agent credentials.

### 15.2 Server-authoritative provenance

Only Torsor writes these fields from Capability Context:

```text
author_agent_id
caused_by_attention_id
caused_by_run_id
activation_id
agent_config_revision
```

Request fields with the same names are not authoritative.

### 15.3 Run visibility

1. An MVP Run has one `home_channel_id`.
2. By default it accepts only Message revisions from that Channel.
3. Project is a code/resource boundary but not a sufficient Message-visibility boundary.
4. Cross-Channel Runs, Artifact sharing, and Project-private Runs are deferred.
5. Every capability call rechecks current authorization.
6. Provider context cannot be recalled, so delivery minimizes context.

### 15.4 Agent configuration versions

1. Agent configuration revisions are immutable append-only records; an Agent's
   `current_config_revision` only points at the latest record. Only a Human may
   create the next revision through explicit idempotent `update_agent_config`,
   which includes the observed `expected_agent_config_revision`. The new
   revision is exactly current plus one. Only one concurrent update succeeds,
   and a stale request writes no partial record.
2. `update_agent_config` accepts only non-secret configuration that may be
   visible to Project collaborators and the execution surface. Provider
   credentials, tokens, private environment values, and private Host material
   do not belong in Agent config. Public events, receipts, errors, and Client
   recovery metadata contain only Agent ID, revisions, and request identity,
   never the complete config body. Durable event actor and time record update
   provenance.
3. A Run pins `agent_config_revision` at creation, and every Activation records
   the actual configuration revision. Updating Agent config does not silently
   change an existing Run, started Activation, ProviderAttempt, Lease, or
   running process.
4. A Human explicitly and idempotently adopts a revision for an existing
   nonterminal Run through `adopt_config_revision`, including
   `expected_run_revision`, `expected_agent_config_revision`, and
   `target_agent_config_revision`. The expected Agent revision must still be
   the owner Agent's current revision. The target must exist for that Agent, be
   strictly newer than the Run's pinned revision, and not exceed the expected
   Agent revision. Terminal Runs, stale Runs, concurrent Agent updates,
   unknown/other-Agent revisions, and equal or older targets fail atomically.
5. Successful adoption only changes the Run's pinned config revision and
   increments its Run revision. It does not revoke, restart, or rewrite an
   existing Activation. Later authorized Activations record and use the adopted
   revision. Idempotent replay returns the original receipt even after later
   Run or Agent changes.
6. Persist every Run history version together with its
   `agent_config_revision`. Snapshot-bounded Run and Thread list projections
   read state, Run revision, and pinned config revision from the same historical
   version; they never combine historical Run facts with the current config
   revision into a state that never existed.

## 16. Message and Thread

### 16.1 Message revision

1. Message revisions are append-only. Each revision fixes its body, tombstone
   flag, Mention set, creation time, and stable ID. Later revisions never
   rewrite the Message's original author, Agent/Run/Attention provenance,
   Thread position, or creation time.
2. Only the original `author_principal_id` may mutate a Message. MVP Human Web
   exposes edit and delete only for Messages authored by the current Human. A
   Human cannot rewrite an Agent's or another Human's expression. This slice
   adds no Agent self-edit entry point; a future one still requires the same
   original Agent Principal and a currently valid capability, never a Human
   override.
3. Explicit idempotent `edit_message` includes
   `expected_message_revision`, the complete new body, and the complete new
   Mention target set. In one transaction it appends a revision, updates the
   latest projection, creates at most one Attention for every valid Mention in
   that revision, and advances the Thread cursor once. Only one concurrent edit
   at an expected revision succeeds; failure creates no revision, Mention,
   Attention, or Thread event.
4. Explicit idempotent `delete_message` includes
   `expected_message_revision`. It only appends a revision with an empty body,
   empty Mention set, and tombstone flag, updates the latest projection, and
   advances the Thread cursor once. It never physically deletes a Message or
   revision. A tombstone is terminal in MVP: there is no restore or later edit.
   Same-request replay returns the original receipt; a new duplicate delete or
   stale request fails explicitly.
5. UI shows the latest revision by default. A tombstone is an explicit deleted
   placeholder, not blank success, and full history exposes each revision's
   Mentions and tombstone state. Historical Attention, RunInput,
   ProviderAttempt, public event, and specific `message_revision_id`
   references remain resolvable and never redirect to the latest revision.
6. Existing Attention, RunInput, and ProviderAttempt facts are not secretly
   withdrawn by edits or deletion.

### 16.2 Thread structure

1. A Thread has one level.
2. Every Reply points directly to its Root Message.
3. Thread is public collaboration space, not an Agent Session.
4. One Thread may contain many Agents, Runs, and candidate Artifacts.

### 16.3 Thread event order

1. Each Thread has a stable monotonic event cursor.
2. It includes Message create/edit/delete, Artifact publication, and public Run-state changes.
3. It excludes ProviderAttempt, Lease renewal, and internal retries.
4. Projects and Channels need no global total order.

### 16.4 Reply freshness

```text
reply(
  observed_thread_cursor,
  optional expected_thread_cursor
)
```

1. Without `expected_thread_cursor`, append concurrently.
2. With it, publish only if the Thread is unchanged.
3. On failure, publish no Message or Attention and return new events.
4. Progress and independent findings default to concurrent append.
5. Synthesis, direction change, and cancellation explanations default by Agent policy to conditional publication.
6. Reply freshness does not change authoritative Run, Worktree, or Artifact state.

## 17. Attention

### 17.1 Triggers

1. An explicit Agent Mention creates Attention.
2. An explicit system operation may create Attention, such as recovery after Run failure.
3. Ordinary Reply does not automatically wake prior participants.
4. Watch, subscription, and automatic participant notification are deferred.
5. Self-Mention does not create Attention by default; self-scheduling uses an explicit capability.

### 17.2 Uniqueness

At most one Attention exists for:

```text
(message_revision_id, target_agent_id, trigger_kind)
```

Message publication and Attention creation share one database transaction.

### 17.3 State machine

```text
Open
├─→ Resolved
└─→ Ignored
```

Resolution records outcome, actor, Activation, time, created/updated Run, created RunInput, published Reply, and Ignore reason.

### 17.4 Concurrent consumption

1. Runtime uses a short handler lease.
2. Only one `resolve_attention(expected_revision)` commits.
3. Side effects use stable derived idempotency keys.
4. Attention does not expire automatically.
5. Old Attention remains unhandled; UI shows age and the Agent may explicitly Ignore it.

### 17.5 Message edits

1. Every Mention in a non-tombstone revision creates one new Attention by
   `(message_revision_id, target_agent_id, trigger_kind)`. Mentioning the same
   Agent in an older revision does not suppress the new revision's Attention.
2. Removing a Mention or tombstoning does not revoke existing Attention.
3. Activation receives both the triggering and current latest revision.
4. A Human explicitly cancels or stops already-triggered work.

## 18. Run

### 18.1 Minimum state machine

```text
Active ⇄ Waiting
Active/Waiting ─→ Paused ─→ Active

any nonterminal state ─→ Completed
any nonterminal state ─→ Failed
any nonterminal state ─→ Cancelled
```

- `Active`: may accept Activation and continue; does not mean a Provider process is running.
- `Waiting`: waits for Message, Human, or external conditions and may reactivate by policy.
- `Paused`: blocks new work until explicit Resume.
- `Completed`: goal complete and current RunInputs explicitly disposed.
- `Failed`: the current line of work cannot complete.
- `Cancelled`: explicitly terminated.

Transient Provider `Running` is not a Run lifecycle state.

### 18.2 State authority

1. A Message saying "done" does not change Run state.
2. Only explicit capabilities change authoritative state.
3. Every transition includes expected Run revision.
4. A terminal Run cannot reactivate.
5. Later work creates a Successor, Retry, or Replacement.

### 18.3 RunLink

Use one relation rather than separate objects:

```text
RunLink
- parent
- fork
- retry
- successor
- replacement
- coordination
- review
```

A coordination Run may relate to multiple Runs.

### 18.4 Terminal-state rules

#### Completed

1. One transaction checks expected Run revision.
2. No `Pending` RunInput may remain.
3. The Agent may batch dispositions through a sequence and list exceptions.
4. New RunInput competes with completion on the same Run revision.
5. A final summary Message may publish atomically but is optional.
6. MVP uses explicit idempotent `complete_run`; Provider turn end, process exit, or Message publication never implies completion.
7. There is no `CompletionDeclaration` object; optional summary, Artifact, and external references use existing relations.

#### Failed

1. ProviderAttempt failure does not automatically fail a Run.
2. Run enters Failed only when Agent, Human, or recovery policy abandons the line.
3. Pending RunInput does not block Failed.
4. Unhandled Pending input becomes `Abandoned(reason=run_failed)`.
5. The same transaction may transfer it to Retry or Replacement.

#### Cancelled

1. Human cancellation and safety stop are not blocked by input cleanup.
2. Logical cancellation precedes asynchronous Provider stop.
3. Unhandled Pending input becomes `Abandoned(reason=run_cancelled)`.
4. Cancellation does not cascade to child Runs by default.
5. Temporary stop uses Paused, not Cancelled.

### 18.5 Input after terminal state

1. Terminal Runs reject new RunInput.
2. The capability returns terminal state and suggests a Successor.
3. The Agent chooses Successor, another Run, Reply-only, or Ignore.

## 19. RunInput

### 19.1 Definition

An immutable assignment fact:

> During one Activation, an Agent assigned a specific revision of a Message to an existing Run.

```text
id
run_id
message_revision_id
run_input_sequence
assigned_by_principal_id
assigned_by_activation_id
source_attention_id
created_at
disposition
disposition_revision
```

### 19.2 Creation

1. Agents create RunInput through a capability.
2. Human `send_to_run` atomically creates a home-Thread Message and RunInput.
3. Human assignment records the Human Principal rather than impersonating an Agent decision.
4. `(run_id, message_revision_id)` is unique by default.
5. A new Message revision may create a new RunInput.
6. One Message revision may be assigned to different Runs.
7. Creation atomically assigns monotonic `run_input_sequence`.
8. Creation increments Run revision.
9. Human `send_to_run` requires the observed `expected_run_revision`; it is not optional. The revision check, public Message, Human-assigned RunInput, revision increment, and delivery Outbox commit in one transaction.
10. Client submission state is separate from the RunInput `Pending` disposition. A definite transaction rejection creates neither Message nor RunInput; a lost response leaves the commit outcome unknown and cannot establish that neither committed.

### 19.3 Semantic disposition

```text
Pending
Incorporated
Declined
Superseded
Withdrawn
Abandoned
```

- `Pending`: requires explicit disposition.
- `Incorporated`: Agent declares inclusion in work or result.
- `Declined`: unrelated or no action; reason required.
- `Superseded`: transferred to another RunInput or Successor; link required.
- `Withdrawn`: source Human or Agent explicitly withdrew it.
- `Abandoned`: unhandled because of failure, cancellation, or unrecoverable cause; reason required.

### 19.4 Batch disposition on completion

```text
complete_run(
  expected_run_revision,
  incorporated_through_input_sequence,
  exceptions,
  optional summary,
  optional final_message_id,
  optional artifact_refs,
  optional external_refs
)
```

Torsor verifies that the Activation received relevant inputs, every input in range has a disposition, no new input arrived during reasoning, and Superseded targets are valid. It can prove delivery and declaration, not correct LLM understanding.

The natural compound operation may atomically publish the final Thread Reply, dispose inputs, and complete the Run. A final Message remains optional for read-only maintenance, external waiting, and work without a public result.

## 20. ProviderAttempt and RunInput delivery

### 20.1 Layers

```text
RunInput disposition
= Agent semantic disposition

ProviderAttempt
= mechanical delivery and execution facts
```

Provider receipt never means `Incorporated`.

### 20.2 Minimum outcomes

```text
Started
Acknowledged
Completed
Failed
Unknown
```

Record adapter/version, capability snapshot, Activation, input RunInput IDs,
request idempotency key, start/end time, and result or Unknown reason.

Persisted and public provider-failure diagnostics use an allowlisted
projection. Run, Activation, ProviderAttempt, Timeline, HTTP, and Web may
contain only a stable error code, outcome, and a bounded generic summary
explicitly defined by the Runtime. Provider stderr, raw process errors, launch
commands and environments, machine paths, credentials, prompts, model output,
arbitrary provider error text, and nested cause messages must not enter those
fields. The Runtime maps error types to fixed diagnostics before persistence;
secret-pattern replacement is not the primary boundary, and failures are not
silently swallowed. Unless a private diagnostic channel has explicit
ownership and opt-in, raw diagnostics may exist only briefly in bounded memory
and are discarded when execution ends.

The current stable codes are `provider_process_start_failed`,
`provider_process_exited`, `provider_protocol_error`,
`provider_policy_violation`, `provider_output_limit`,
`provider_stderr_limit`, `provider_io_error`, `provider_timeout`,
`provider_cancelled`, `provider_cleanup_failed`,
`provider_runtime_monitor_failed`, `provider_not_started`,
`provider_worktree_execution_failed`, `provider_worktree_authority_lost`,
`provider_recovered_worktree_authority_lost`,
`provider_recovered_failed`, `provider_recovered_unknown`, and
`provider_execution_failed`. Public detail uses
`<code>: <generic summary>` and is at most 160 characters.

### 20.3 Provider capabilities

Adapters expose a versioned profile:

```text
accepts_input_while_running
supports_cancel
supports_resume
supports_session_continuation
supports_graceful_pause
supports_idempotent_input
```

Unknown capabilities are unsupported.

### 20.4 No real-time Steer

1. Persist RunInput immediately.
2. Do not fabricate Delivered or Accepted.
3. Rebuild context from durable RunInput in the next Activation.
4. The Agent may create a parallel or Replacement Run rather than wait.

### 20.5 Guarantees

```text
local domain effects: effectively-once
external Provider delivery: at-least-once or explicit Unknown
semantic handling: RunInput disposition
```

There is no generic end-to-end exactly-once promise.

## 21. Activation, idempotency, and crash recovery

### 21.1 ActivationAttempt

```text
activation_id
agent_id
cause
scope
config_revision
started_at
finished_at
outcome
```

Activation is a runtime record, not a primary user object.

### 21.2 Idempotency

```text
(principal_id, capability_name, idempotency_key)
```

1. Store payload hash and complete result.
2. Same key with a different payload conflicts.
3. The record lives at least as long as durable objects it created or changed.
4. Log GC must not allow an old request to repeat effects.

### 21.3 Transactional Outbox

One database transaction covers Message plus Attention, RunInput plus delivery scheduling, Run state plus notifications, and Artifact descriptor plus upload-completion event. External Workers may consume Outbox repeatedly.

The first trusted Artifact slice finalizes immutable report bytes only. Torsor must accept bounded bytes or a byte stream, compute SHA-256 itself, and confirm durable storage before atomically committing the descriptor, `ArtifactPublished`, `artifact.published` Outbox event, and complete idempotency result in the existing Kernel transaction. Storage failure publishes no descriptor; Outbox is not a promise to upload later while claiming the content is already downloadable.

### 21.4 Expired Activation

1. Run changes require expected revision.
2. Worktree writes require current fencing token.
3. Terminal Run, revoked permission, or resolved Attention invalidates old scope.
4. Late Provider output may be retained but cannot change domain state automatically.

### 21.5 Reconciler

Runtime periodically recovers unfinished Outbox work, expired Activation, Unknown ProviderAttempt, Open Attention, suspect Writer Lease, and incomplete Artifact finalization. Recovery continues to use idempotency keys.

A report finalization request is identified by `(principal_id, run_id, idempotency_key)`. Reusing it requires identical bytes and expected Run revision, otherwise it conflicts. Retry after a lost commit response returns the original Artifact and provenance without duplicate events. A new Activation may retry only with current Run read authorization; retry does not revive old Activation authority.

This slice uses caller-driven retry, not background replay of Provider output. A crash during staging leaves only an invisible temporary file; content publication before database commit leaves only an invisible content-addressed blob; a lost response after commit is recoverable from durable idempotency results and Run/Thread projections. Retry verifies and reuses the blob and rechecks current authorization, Activation, and Run revision in the transaction. Revocation or a terminal Run blocks new descriptors; currently authorized Humans/Runtime may still query committed descriptors. No automatic orphan/staging deletion is included: cleanup is offline maintenance, avoiding races with concurrent finalization.

The integrated durable-causal-limit, trusted-Artifact, physical-Worktree, and provider-diagnostic-boundary database uses schema **19**. It retains section 25's Run root/parent/depth, immutable constraints, admission index and durable configuration alongside section 23's trusted report descriptors, section 22's physical identities, executions and irreversible Writer publication fence, and schema 18's native execution ProviderAttempt/policy receipt bindings, while adding the pinned Agent config revision to every Run history version. Schema 18 is rejected because it cannot reconstruct pre-adoption Run/Thread snapshots correctly; schema 17 also lacks native receipts. No migration is supported. Schema 16 is rejected and recreated because it may contain raw provider diagnostics publicly persisted before this boundary; the former causal-only, Artifact-only and Worktree-only schema 14 layouts and integrated schema 15 are also incompatible. Equal version numbers must not authorize different layouts. Opening any older or unversioned nonempty development database must fail explicitly before applying DDL/bootstrap, without migration, version rewriting, or data deletion. Operators stop old processes and explicitly use a fresh disposable database and fresh managed root. Schema 19 reopen still validates durable causal configuration and Worktree storage identity.

`user_version = 19` is not layout proof. Before any DDL, bootstrap or configuration write, existing databases undergo read-only comparison against a complete schema fingerprint generated from trusted DDL in an isolated memory database: object sets, columns/types/nullability/defaults/PKs/FKs, indexes/uniqueness/partial predicates, triggers, CHECK and STRICT constraints. Compare SQLite-parsed metadata and SQL tokens that preserve literal/operator semantics; ignore only whitespace, comments and unquoted keyword/identifier case, never whitespace inside strings. Reject missing, extra-incompatible, partial, corrupt, predecessor-shaped or future layouts without changing file bytes or logical state; never repair with `CREATE IF NOT EXISTS`. SQLite-owned statistics objects are outside the application layout. Only version 0 with no persistent objects may execute DDL, initial configuration and bootstrap in one transaction, with complete rollback on failure. Valid schema 19 reopen does not reapply bootstrap or modify durable causal configuration or storage identity.

The Runtime Host must bound consecutive recovery passes, yield to the event loop before continuing, and recheck shutdown. Backlog processing must not starve HTTP, timers, signals, or shutdown handling. Idle polling waits must be interruptible by shutdown and must remove their listener and cancel any no-longer-needed timer regardless of which side completes first.

## 22. Worktree and Writer Lease

### 22.1 Ownership

1. A physical Worktree belongs to one Run.
2. Writer Authority belongs to the current Agent Activation or Human Principal.
3. One Worktree has one platform-recognized Writer Authority; a Human may force takeover, but risk from an unstopped old process must be reported.
4. Lease carries a monotonically increasing fencing token.

The first physical execution slice further requires:

The `write-probe-v1` restrictions below describe the foundation slice. Explicit
native Provider provisioning, environment, and whole-process-tree requirements
are extended by the [trusted-local policy specification](../specs/trusted-local-provider-policy.md).
Unselected policy never widens the original restricted behavior.

5. Kernel persists an immutable `PhysicalWorktree` runtime record: repository identity,
   canonical repository path, full base commit, source Run, opaque worktree ID,
   canonical directory path, and filesystem identity. Paths are local Runtime handles,
   not public Thread events or Provider context. Different Runs cannot register the same
   directory, path alias, or filesystem identity; this slice never transfers an old directory
   to another Run.
   Registered directories cannot be ancestors/descendants of one another either,
   preventing implicit nested sharing.
6. Before external effects, persist an execution intent binding source Activation,
   Runtime Principal, executor incarnation, lease generation, fencing token, and a private
   execution receipt. A PID is diagnostic information, not recoverable process authority.
7. Lease generation is a logical authority sequence, not physical isolation evidence.
   Only a trusted executor converts authority into file/process operations; Agents, HTTP,
   and ACP receive no general write entry point.

### 22.2 Creation

1. A writable Run need not create a Worktree immediately.
2. Create it lazily on first write.
3. Pin repository identity, base commit/content revision, Run, and Worktree generation.

The first slice does not implement general provisioning. A trusted local Host supplies a
detached Git worktree pinned to a full commit under a dedicated root; the executor validates
real paths, directory identity, Git common directory, and detached HEAD before registration.
Git hooks, filters, repository scripts, checkout, networking, and arbitrary commands are
outside its capabilities.

An exclusive-create local owner marker binds the managed root to one Kernel storage identity.
Another database cannot reuse it. Concurrent operation of database copies is unsupported;
recreating a development database requires a fresh root, never automatic marker deletion or
takeover of old directories.
This marker is Host storage-ownership metadata outside the Worktree, not Run write authority.

The sole controlled tracer is `write-probe-v1`: exclusively create a fixed probe file, then
start a fixed Node child to process its content and return a digest. Use an exact executable
and argument vector, `shell: false`, no inherited code-injection settings such as
`NODE_OPTIONS`, and no execution of repository content. The child creates no descendants;
this audited fixed protocol is the precondition for direct-child stop confirmation, not a
claim of arbitrary process-tree isolation. Test process drivers/fixtures stay behind a narrow
isolated seam for later Provider Conformance Harness adoption, not another Provider engine.

Before every platform-mediated file creation inside a Worktree or spawn, recheck lease token, generation,
fencing token, current Activation/Run, execution receipt, and directory identity.
Authorization and synchronous effect initiation share a Kernel write transaction lock;
the previously committed intent must survive file/process failure. SQLite and the OS do not
form one atomic transaction: crash windows remain uncertain, with no arbitrary external
effect exactly-once promise.

The Writer publication fence also covers the Activation's Agent Kernel commands (including
idempotent replay), `AppendRunActivity`, report finalization and Runtime success settlement.
Check current generation, fencing, holder, expiry and physical quarantine inside the
transaction. New tokens, late `close`, clock rollback or acquisition by the old Activation
cannot undo lost authority; recovery requires a new authorized Activation. Human stop and
Runtime failure/Unknown, process stop and reconciliation records remain available, but
cannot publish success or raw output on the old Writer's behalf. Authorized reads and a
new Activation's idempotent recovery of committed Artifacts retain section 23's rules.

`CompleteRun` and Runtime success settlement additionally require every associated physical
execution to have normally reached `StopConfirmed`. If this Activation already committed
its own `CompleteRun`, `FailRun` or `WaitRun` under valid authority, logical Activation
revocation does not prevent Runtime acknowledgement of **that committed decision**.
It still requires matching current Run generation/state, unexpired lease and Activation,
normal stop evidence, and no publication revocation. This exception permits settlement
only, never renewed Agent mutation authority. Executor restart revokes a leftover
publication window even after confirmed physical stop; an old successful return value
does not grant post-recovery write authority.

Recovery must not derive post-restart Writer success authority from a committed
`ProviderAttempt.Completed`. If `FinishActivation(Completed)` for an orphaned Activation
is rejected with `WriterAuthorityLost`, Runtime submits `FinishActivation(Expired)` with
a separate idempotency key and fixed authority-lost reconciliation detail, then acknowledges
the recovered outbox delivery. Preserve committed Run, ProviderAttempt, Reply, Artifact,
activity and causal-capacity facts: do not rerun the Provider, republish success or change
a completed Run into failure. Existing Failed/Unknown, Waiting and stale-generation
recovery follows its respective state rules; finished Activations are not finished again.
A second restart produces no duplicate facts.
If the authority-lost `Expired` settlement conflicts because another Host concurrently
finished the same Activation, reread its authoritative Run projection. Only an existing
`finishedAt` permits preserving that terminal outcome and acknowledging delivery without
overwriting it. An unfinished Activation, failed read or other conflict still fails;
this is not blanket suppression of `Conflict`.

A normal `probe` succeeds only with the expected fixed digest, confirmed normal exit and
still-current write authority. Normal drain retains the lease through the Activation's
public result/state commits; `stopActivation`/Host shutdown releases it afterward.
Publication and competing Writer acquisition therefore remain serialized by the Kernel
write lock. Cancellation, timeout, force termination, failure, recovery or uncertainty
irreversibly revokes that execution's publication authority. `StopConfirmed` proves stop,
not restored authorization. Reports accept bytes only through authorized `publish_report` /
`finalizeReport`, preserving the existing 1 MiB/4096-chunk bounds, current scope, provenance,
idempotency and storage acknowledgement; never submit descriptors directly.

The controlled child's result channel permits at most 65 bytes (one SHA-256 hex plus
newline); stderr is limited to 1024 bytes and its contents are discarded. Extra, malformed,
oversized output or abnormal exit fails instead of truncating into success. Do not use
result IPC that first deserializes arbitrarily large objects. The environment permits
only necessary OS entries, not inherited credentials or injection settings. Public errors
use fixed descriptions; local paths, PIDs, receipts, raw process errors/output and
environment never enter Timeline, reports or ACP transcripts. Full local diagnostics stay
in Runtime-only records. ACP production tool denial and the independent harness's
allowlisted contract remain unchanged.

### 22.3 Lease expiry

Expiry does not prove the old process stopped. Never hand the same directory to a new Writer
solely because a Lease timed out:

1. Only exact stop evidence permits the same Run to reuse its directory; otherwise
2. mark the directory `Quarantined`, rejecting new platform writes and Writer acquisition.
3. A later slice may create a **different physical directory** from a known base/checkpoint.
   Increasing generation, renaming, replacing a token, or copying a suspect directory is
   not isolation evidence.

`Starting` intents, running processes, `StopRequested`, and `Uncertain` block lease release
and reassignment even after expiry, including competing acquisition through independent
Kernel connections. Startup recovery quarantines unfinished intents from an old executor
incarnation. PID presence/absence, cached exit codes, or Host restart cannot clear quarantine.

This slice accepts only `close` observed by the executor retaining the original child handle
(or definite evidence that spawn never happened) as direct-child stop evidence. Late
confirmation conditionally updates its own execution using the original receipt, never a
successor. Losing the handle leaves quarantine in place; cross-restart OS containment proof
and manual clearance are not implemented and cannot be bypassed with resolution text.

### 22.4 Pause, Cancel, and GC

1. Waiting/Paused releases Writer Lease after execution stops.
2. Keep Worktree isolated while Provider stop is unconfirmed.
3. Cancel does not immediately delete Worktree.
4. Stop processes and preserve required patch/log before retention.
5. GC only after terminal Run, no active/suspect Writer, required Artifacts finalized, retention elapsed, and no investigation/hold requirement.

In this slice Host shutdown waits for admitted controlled operations to stop or persist
quarantine before closing Kernel. A shutdown request during recovery must prevent subsequent
HTTP listener startup and new Runtime admission. Stop control is safety authority over an existing process
handle and does not require an expired write lease to remain live.
Stop entry irreversibly revokes this executor's local authority and independently uses the
original handle to request stop, wait within bounds and force stop if necessary. Never wait
for a SQLite write lock, durable revocation or `StopRequested` persistence before requesting
physical stop. Normal drain also stops physically before persisting evidence. Database
contention, startup failure, cancellation, timeout, output limits and shutdown follow this order.

`DatabaseSync` blocks its calling thread even behind a Promise API. SQLite busy waits in
the authority monitor, other Kernel commands or cleanup retries must not occupy the event
loop responsible for deadlines, AbortSignal and shutdown callbacks. Before the first
physical effect, that Kernel instance enters conservative nonblocking supervision until
it closes: each synchronous database operation scope uses no-wait lock admission and
restores the configured busy timeout (5000ms in production) in `finally`, without crossing
an `await`. Contention fails explicitly; persistence can retry with existing idempotency
without weakening Writer checks. Monitoring uses a short rollback-only snapshot, never
authority to initiate mutation/publication; real effects still revalidate full authority
inside `BEGIN IMMEDIATE`. Original-handle deadlines and stop remain independent, including
when another execution retries persistence. Acceptance uses the unshortened production
timeout, an independent connection holding a writer lock for 6500ms and independent
process-liveness observation: a 1000ms lease requests stop near its deadline and converges
durably after unlock. Cover queued cancellation/explicit stop, executor/Host shutdown
and multiple handles as well.

Local stop/evidence and durable revocation, quarantine/stop disposition and lease release
are separately idempotent: do not resend successful stop/force signals on the same handle;
retain original close evidence. Cached promises coalesce in-flight persistence only;
failures remain retryable, never completed cleanup. Replace the deadline only with an
active cleanup retry path. Each failure explicitly returns an error and schedules retries
at bounded intervals until revocation and stop disposition are durable. Missing stop
confirmation persists Uncertain/quarantine; releasing a database lock is not stop evidence.
Late original-handle close retains existing receipt-based reconciliation.
Shutdown waits for all admitted handles' stop attempts. If persistence fails, Host retains
Kernel for retries, stays closing and admits no work; later `close` retries instead of
permanently caching failure. Unexpected process exit still relies on conservative startup
recovery of old intents. Schema remains 16, with no migration or new Run state.
Unconfirmed stop never
deletes the directory or releases it for reuse. Pause/Resume, Human Terminal, controller lease,
Files UI, retention policy, and GC are outside this slice.

## 23. Artifact and integration

### 23.1 Artifact identity

Authoritative references are immutable: commit SHA, patch digest, or immutable blob digest. A movable branch ref is auxiliary metadata.

```text
content_digest
producer_run_id
producer_activation_id
base_revision
media_type
byte_length
producer_thread_root_id
visibility_scope
```

Reports use `sha256:<lowercase hex>`, fixed `text/plain; charset=utf-8`, and a Torsor-generated `base_revision` of `run:<id>@<expected revision>`, not a claimed Git commit. Source Run, Activation, Thread, and home Channel derive from trusted context. Provider-supplied digests, descriptors, paths, and `file://` URLs are not authoritative. Ordinary `PublishArtifact` commands must be rejected; only the trusted byte finalizer may enter the publication transaction.

Reports are limited to 1 MiB and streams to 4096 chunks. The finalizer copies input bytes before hashing; storage adapters receive no Provider paths. The narrow interface provides immutable writes and reads by digest/length only, is statically configured by the trusted Host, and is not exposed to Providers. One descriptor is retained per Run/digest; publishing identical content under another key conflicts rather than rewriting provenance.

Parent and child Runs may finalize identical bytes and share one content-addressed blob, but retain separate descriptors, source Run/Activation/Thread, and idempotency scopes. An Artifact traces through `producer_run_id` to its Run's immutable causal root, parent Attention/Run, and depth rather than duplicating mutable causal fields. Neither ancestry nor an identical digest grants cross-Run read access. Finalization, download, failure and replay do not allocate/release Run slots, rewrite causality, dispose RunInput, or implicitly complete a Run. After restart, Run/Thread and paginated projections must retain both causal fields and Artifact references.

The development/test local layout is `sha256/<64 hex>` and `staging/<random>.tmp` under a private root. Exclusively create, write, and flush a staging file, then atomically hard-link without replacing the destination. Existing destinations must match length, digest, and all bytes, never be overwritten. Reads also verify length and digest. Reject invalid digests, traversal, symlinks/junctions, and non-regular files. The root and ancestors must be trusted Host-controlled and outside Provider/Worktree write scope; this adapter is not a sandbox against hostile concurrent writes by the same OS user. POSIX also flushes directories; Windows supports process-crash/restart recovery but does not promise directory flush/power-loss durability unavailable in portable Node APIs. Production remote storage is a separate adapter.

### 23.2 Permission

1. Artifact inherits home-Channel visibility by default.
2. Every descriptor query and download rechecks current Principal, Project, home Channel, and Run/Activation scope, including after asynchronous storage reads and before returning bytes.
3. The public contract exposes Artifact IDs and descriptors, not internal paths or direct storage URLs. HTTP uses `GET /api/v1/artifacts/:id` and `GET /api/v1/artifacts/:id/content`. Possession of an ID/digest is not authorization. Responses disable caching; content is returned as a plain-text attachment.
4. In the current local permission model, Humans/Runtime have global read authority and Agents are limited by live Activation Project/Channel/Thread/Run scope. This slice adds no ACL administration system. Future short-lived signed URLs must not bypass current authorization checks.
5. Agents see platform Artifact metadata only when `producer_run_id = scope.runId`; Attention scope has no Run and therefore no Artifacts. Apply this to current/historical Thread and Run projections, lists/pages, conditional-command catch-up errors, events/SSE, and Runtime context delivered to Providers. A shared Thread, ancestry or identical content does not widen authorization. Do not return filtered Artifact items, counts, digests, provenance or event payloads. Explicit public Message text remains Channel/Thread communication, not a descriptor or read grant.
6. Validate Principal and current Activation/scope before looking up an Artifact ID. For authorized callers, absent and inaccessible IDs produce identical generic `NotFound` (HTTP 404), message and response headers without existence, storage or provenance details; never read an inaccessible blob. Unauthenticated calls remain 401. Deterministic stale/revoked-scope errors occur before lookup regardless of ID existence.
7. Filtering does not stall bounded scans: `scannedThroughEventId` advances as an opaque high-water mark, not a hidden-report count or identity. SSE emits a `checkpoint` event containing only the opaque `cursor` and sets `id` for filtered tails. Native reconnects and Client replacement connections use this watermark without synthesizing Artifact timeline items, exposing filtered payloads, clearing loaded history or disturbing Composer state.
   Conditional-command catch-up scans at most 100 events and returns `scannedThroughEventId` and `hasMore`, filtering after scanning. Artifact events are neither forwarded nor accepted through cross-window BroadcastChannel; each window consumes its own authenticated stream, and an old connection cannot overwrite a new scope's cursor.

### 23.3 Integration

1. Do not add a global mutable `Accepted` state.
2. The Agent decides from Prompt, context, and capability whether to create a PR, wait for CI, merge, or only publish an Artifact.
3. Candidate validation/composition may use an ordinary coordination Run; there is no fixed Integration Run or central Integration Manager.
4. A writing/composing Run still uses an exclusive Worktree.
5. Creating a PR proposes integration; only merge enters the target branch.
6. Persist source Run, Worktree generation, source commit, target repository/branch, idempotency key, operation result, and external reference for important external operations.
7. External systems remain authoritative for PR, CI, and merge state.
8. Adoption is expressed through later Run, Artifact, Message, RunLink, and external references.
9. Human Approval for protected resources is determined by Agent Prompt, capability authorization, and external protection rules, not a generic Approval object.

### 23.4 Artifact input

MVP adds no `ArtifactInput`. Reference an Artifact in a Thread Message/card and assign that Message revision as RunInput.

References use finalized Artifact IDs only. References, report text, and Provider output do not automatically grant read access, create RunInput, or complete a Run. The optional Runtime `publish_report` capability accepts only a stable request key and report text, never digest/location/provenance. Arbitrary ACP `publish_artifact` remains disabled.

## 24. Provider cancellation, Pause, and Resume

### 24.1 Resume

`resume_run` guarantees a new Activation on the same logical Run. Provider Session reuse is only an optimization.

### 24.2 Pause and Cancel

1. Change Torsor logical state atomically first.
2. Revoke new-effect permission and Writer Lease.
3. Request Provider stop asynchronously.
4. UI displays logical state separately from Provider execution state.

Physical execution records independent facts, not new Run states:

| Fact | Meaning |
|---|---|
| `Starting` / `Running` | Durable intent / observed child start; neither means completion |
| `StopRequested` | Further writes prohibited and stop requested; not stop evidence |
| `StopConfirmed` | Original handle confirms exit (not success), or definite no-spawn evidence |
| `ForceTerminated` | Force termination requested and original handle subsequently confirms exit; successful kill alone is insufficient |
| `Uncertain` | No confirmation by deadline, lost handle, or crash in the spawn window; quarantine is mandatory |

Record request and observation times, PID when available, reason, stop evidence, and transition
history. Provider timeout, AbortSignal, protocol cancel acknowledgement, terminal Run state,
and lease expiry never imply `StopConfirmed`. Controlled-child exit never completes a Run.

### 24.3 Provider without Cancel

The Run may still cancel immediately: reject old capabilities, isolate Worktree, show termination as pending/unknown, and prevent late output from publishing or changing Run/RunInput automatically.

The same applies to Providers claiming Cancel support without physical confirmation. The first
slice does not grant such Providers native Worktree shell/write tools. Until general descendant
control and OS isolation exist, only the controlled tracer is permitted; logical fencing is
not a security sandbox against hostile same-user processes.

### 24.4 Retrying Unknown

Retry automatically only when the adapter proves idempotency. Otherwise retain `Unknown` for a later Activation to evaluate.

## 25. Delegation, loops, and budgets

### 25.1 Causal chain

The first durable causal-limit slice uses immutable Run provenance:

```text
causal_root_id
parent_attention_id
parent_run_id
delegation_depth
```

1. `causal_root_id` is the initiating Human Message ID, not a Thread ID or Provider Session. Each new Human Message from `StartThread`, `ReplyToThread`, or `SendToRun` starts a root; multiple Mentions in that Message share it.
2. All current new Runs are created through `ResolveAttentionWithRun`. Kernel derives provenance from the authenticated Attention Activation, the Attention's exact Message revision, and that Message's server-authored provenance. `parent_attention_id` is the Attention being resolved.
3. A Run directly triggered by a Human Message has `parent_run_id = null` and `delegation_depth = 0`. A new Run triggered by an Agent's `PublishRunReply` or `CompleteRun.finalReply` uses the Message's `caused_by_run_id` as parent, inherits its root, and increments depth by one. A terminal parent does not reset provenance or depth.
4. Attention traces causality through its immutable Message revision and Message provenance rather than duplicating budget fields that could drift. Creation without trustworthy Human or Run provenance fails closed, never falling back to a new root.
5. Continuing an existing Run from Attention, Human Send-to-Run, and Activation/Provider retries neither rewrite existing Run provenance nor allocate another Run slot. Later delegation from that Run uses its original root, not its newest input's root.
6. Agent/Provider payload root, parent, depth, or limit fields are not authoritative; Kernel rejects explicit submission of these server-owned fields. This slice adds no direct Fork, Retry, Successor, or Replacement creation commands; future creation paths must reuse the same admission boundary.

### 25.2 Budget envelope

This first slice enforces only two hard limits, with approved initial defaults:

```text
delegation depth: 4
max non-terminal Runs per causal root: 50
```

1. Maximum depth is inclusive at 4 (initial Runs are depth 0). At most 50 nonterminal Runs share one root, including initial Runs and counting across all Agents in that root.
2. Values belong to server-owned `KernelOpenOptions.causalLimits`, not Agent configuration or command parameters. New databases persist defaults or explicit configuration; all connections and restarts read the same durable configuration. Reopening with explicitly different values fails clearly. There is no online limit-changing command yet.
3. In one `BEGIN IMMEDIATE` transaction, Kernel derives provenance, checks depth, counts durable Run occupancy, creates Run/RunInput, resolves Attention, and writes events, Outbox, and idempotency results. At most one of multiple SQLite connections racing for the last slot succeeds.
4. Both `Active` and `Waiting` occupy one slot. Activation count, Provider state, lease expiry, and process exit do not release capacity. A future `Paused` state also remains nonterminal.
5. Only a successful `Completed`, `Failed`, or `Cancelled` commit releases that Run's slot. It neither recursively releases children nor proves Provider stop. Terminal events and capacity evidence commit atomically. Pending Attention from a terminal parent may still create a child, preserving root/depth and rechecking capacity.
6. Capacity counts current nonterminal Runs, not lifetime Run count or prepaid balance. Successful command replay returns its original idempotency result without counting again; only a new logical Run occupies a new slot. Failed transactions roll back Run, input, decision, events, Outbox, and idempotency result together.
7. Rejection returns `CausalLimitExceeded` with root, proposed depth, current occupancy, effective limits, and the exceeded dimension. Attention stays Open and the failed command does not consume handler authority. The Agent may explicitly Ignore, continue an existing Run, or retry after conditions change; no silent discard or apparent success.
8. Project/Agent concurrency quotas, fan-out, Attention rate, Provider cost, budget allocation, and a full policy language are deferred. This slice does not claim to enforce them or add UI budgeting.

### 25.3 Default Agent policy

1. Do not repeatedly Mention the same Agent for the same fact without new evidence.
2. Do not create duplicate Replacement Runs of the same kind.
3. Coordination first reads and manages existing Runs.
4. Ask a Human near budget limits.

## 26. Multi-client synchronization

1. Events have stable `event_id` and resumable cursor.
2. Clients deduplicate by event ID.
3. When a cursor is compacted, return a snapshot and new cursor.
4. HTTP command responses and realtime events may arrive out of order.
5. Merge using entity revision and event ID, not arrival order.
6. Window route, scroll position, and draft are local Client state by default.

## 27. Privacy and minimum context

1. By default, an Activation receives only its triggering Thread, related Run, explicit RunInputs, and required Artifacts.
2. It does not automatically receive the entire Channel history.
3. Broader reads require Channel permission and explicit capability.
4. If a Mention targets an unauthorized Agent, MVP rejects the whole publication transaction rather than showing apparent notification success.
5. MVP supports tombstones only; legal deletion, cryptographic erasure, and tenant retention require separate design before production multi-tenancy.

## 28. Audit, metrics, and explainability

### 28.1 Minimum audit fields

```text
event_id
actor principal
activation_id
causation_id
correlation_id
entity revision before/after
idempotency key
timestamp
result
```

Sensitive Prompt content and hidden reasoning are not stored by default.

Provider and process diagnostics likewise do not enter public audit or durable
projections by default. Public diagnostics retain only stable error codes,
outcomes, and allowlisted generic summaries; local developer logs must not
implicitly print credentials or complete environments.

### 28.2 Base metrics

- Open Attention age.
- Pending RunInput count.
- ProviderAttempt Unknown.
- Stale revision conflicts.
- Late output.
- Suspect Worktree Lease.
- Run terminal latency.
- Delegation depth.
- Budget consumption.

For this slice, the last two metrics mean immutable root, parent Attention/Run, and depth in Run projections; provenance, effective limits, and post-commit nonterminal occupancy in `RunCreated`; root and post-release occupancy in `RunCompleted`, `RunFailed`, and `RunCancelled`; and admission evidence in limit errors. Occupancy comes from durable Run state within the same transaction and is explainable through creation/terminal events, not an in-process counter. Rejected creation commits no new domain event. Restart preserves provenance, configuration, and events. Cost accounting and other budget metrics remain deferred.

### 28.3 Explainability

Message, Run, RunInput, RunLink, and Artifact must trace back to the original Human Message. Full hidden reasoning is not required.

## 29. Distinctions the UI must preserve

Do not collapse these into one `Running/Done` state:

- Run logical state.
- Provider execution state.
- Stop requested.
- Provider stop confirmed.
- RunInput disposition.
- Provider delivery outcome.
- Late output.
- Worktree quarantined.

Human-facing examples:

```text
Added to R1
Waiting for R1
Processing
Transferred to R2
Not handled: Run failed
Cancelled; Provider stop confirmation pending
```

## 30. GC and long-term retention

### 30.1 Not ordinary disposable logs

- Message revision.
- Attention decision.
- Run.
- RunInput disposition.
- Artifact descriptor.
- Terminal-state event.
- Critical idempotency record.

### 30.2 Policy-based GC

- Raw Provider logs.
- Session handle.
- Temporary output.
- Terminal Worktree.
- Rebuildable cache.

GC must not change domain state.

## 31. Completeness conclusion

The MVP kernel can express:

- Human/Agent Channel and Thread collaboration.
- Explicit Mention and Attention.
- Agent-created and Agent-managed Runs.
- Multiple concurrent instances of one Agent.
- Multi-Agent delegation.
- Reliable RunInput ownership and Provider-neutral delivery.
- Providers without Steer/Cancel/Resume.
- Worktree single-writer isolation and failure containment.
- Retry, Fork, Replacement, and Coordination Runs.
- Artifact production, Agent-directed external operations, and optional coordination.
- Multi-client synchronization.
- Message edit and deletion history.
- Context freshness.
- Late output.
- Crash recovery.
- Delegation loops and budget control.

No current evidence requires:

- Task.
- Decision.
- Result.
- Approval.
- Central Coordinator.
- Global Agent Session.
- Unique Response Authority.
- Workflow DAG.
- Global Artifact `Accepted` state.

### 31.1 Risk-proportionate local single-developer review boundary for MVP 0.1

The initial supported MVP 0.1 deployment is one developer deploying and using
Torsor on their own computer under an explicitly selected trusted-local policy.
The Provider runs with that developer's local privileges. The assigned Worktree
cwd and Writer Lease provide platform-recognized authority and coordination, not
a hostile-code sandbox. MVP does not promise multi-tenant isolation, defense
against a malicious local owner or compromised Host, containment of programs
that deliberately daemonize and escape the owned process tree, or exactly-once
external MCP/API effects. These non-goals do not weaken section 14 identity,
provenance, and terminal boundaries; section 22 Lease, fencing, stop, and
quarantine contracts; section 27 privacy and minimum-context rules; or existing
authorization, current schema 19, and explicit-failure contracts.

For the remaining MVP work, a release-blocking finding must have a reproducible
supported path, credible user or data-integrity impact, and a minimal acceptance
test. A demonstrable violation of a promised trust or data-integrity boundary may
block even when crafted input is rare, and inexpensive fail-closed validation is
worth adding. Priority blockers are:

- Two platform-recognized or still-writing Writers in one Worktree.
- An old child still writing, or its directory being reused, after cancellation,
  Lease expiry, or an Unknown stop result.
- Stale output/results being published, or delivery being acknowledged without
  safe completion.
- Incorrect authentication, authorization, or provenance, or credentials/private
  text entering durable logs or public projections.
- A new user being unable to install and start the supported package/quick start
  from a clean checkout as required by section 45.

A severity label alone does not replace likelihood, actual exposure, user impact,
and fix cost. Speculative attacks by a malicious local owner, malformed inputs
unreachable on a supported path without crossing a boundary, future multi-user
or hostile-code capabilities, style issues, and exhaustive adversarial enumeration
do not automatically block MVP. Record them as follow-up only when useful.

Before merge, retain independent EXACT-HEAD review and green relevant hosted CI
on the same final SHA. After a finding is fixed, fresh review focuses on the final
SHA's delta, original reproduction, and nearby invariants. Run the smallest
meaningful tests plus hosted CI, repeating full suites only when the change
warrants their scope. Do not call a PR clean while a real boundary defect remains;
once no reproducible blocker remains within these trust assumptions, do not freeze
each MVP PR in an endless perfect-security review loop. This criterion applies to
all remaining MVP 0.1 work, not only trusted-local implementation.

## 32. Product choices still requiring Human Review

1. **Whether an ordinary Reply wakes previous Thread participants.** Recommended MVP default: Mention-only.
2. **Whether Run always binds to a home Channel.** Recommended MVP default: yes.
3. **Whether an existing Run pins Agent configuration.** Recommended: pin and upgrade explicitly.
4. **Whether completion requires a public summary.** Recommended: no; support atomic summary linking.
5. **Which integrations or deployments require Human Approval.** Recommended: Agent Prompt, capability authorization, and protected external systems decide; no generic Approval.
6. **Hard deletion and retention periods.** Deployment- and privacy-specific.
7. **Default budget, depth, and concurrency values.** Approved for the first slice: maximum depth 4 (root Runs are 0), at most 50 nonterminal Runs per causal root; server-owned durable configuration and capacity semantics are in §25.1–25.2. Cost, fan-out, and other budget dimensions still need later design.
8. **Physical Worktree retention for Waiting, Paused, Failed, and Cancelled.** Runtime configuration.
9. **Whether Human direct Send-to-Run is required.** Proven by the Workbench story; MVP supports atomic public Message plus Human-assigned RunInput.
10. **Whether unauthorized Mention fails the whole Message or only the Mention.** Recommended: fail the whole transaction.

These choices do not block the kernel objects and invariants.

## 33. Recommended implementation order

1. Principal, Capability Context, and server provenance.
2. Message revision, Thread event cursor, and Attention.
3. Run, Run revision, RunLink, and state machine.
4. RunInput, disposition, and terminal transaction.
5. IdempotencyRecord, Outbox, and Reconciler.
6. ActivationAttempt, ProviderAttempt, and capability negotiation.
7. Worktree generation, Writer Lease, fencing, and quarantine.
8. Artifact digest, storage, external operation result/reference, and integration capability.
9. Multi-client synchronization, UI state, and metrics.
10. Budget, recursion limits, and GC.

## 34. Torsor design charter

Use this goal for future iterations:

> **Design a minimum, semantically closed, Agent-native, composable, traceable, recoverable, and evolvable collaboration kernel. Humans use familiar Channels, Threads, and Messages; Agents work concurrently through capabilities; Torsor records facts and protects hard boundaries; Providers and UI are replaceable adapters. Add capabilities, runtime resources, or projections before adding domain objects, and add an object only when a concrete story cannot otherwise be expressed.**

The direct product position is:

> **Torsor is a Human-Agent collaboration and execution platform, not a central manager that makes semantic decisions for Agents. The platform provides capabilities and boundaries; Agents understand, judge, and act; Humans retain observation, guidance, takeover, and stop authority.**

```text
Prompt             determines what an Agent should do
Capability         determines what an Agent can do
Torsor             records facts and protects mechanical boundaries
External system    determines whether an external operation is accepted
Human              retains final control and intervention
```

Evaluate new designs against:

1. **Minimum kernel:** no domain object without a concrete story.
2. **Semantic closure:** every user-visible fact has a source, persistence location, and transition.
3. **Separation of responsibility:** Agent judges semantics; Torsor protects invariants; Provider executes; Client composes views.
4. **Agent-native concurrency:** serialize only a contested resource.
5. **Provider-neutrality:** no Provider-specific Session, Turn, Steer, or Interrupt model in the kernel.
6. **Traceability and recovery:** important behavior traces to Human Message, Attention, Run, RunInput, and Artifact, and recovers from durable facts.
7. **Least privilege and safe failure:** platform-enforced identity, authorization, revision, idempotency, Lease, and fencing.
8. **Projection-oriented UX:** Page, Tab, Pane, and Workspace are views, not automatic domain objects.
9. **Platform, not central manager:** Torsor provides capability, facts, isolation, observability, and control without hard-coding one workflow or role.
10. **Plugin-oriented external capability:** do not rewrite CLI/API/MCP capabilities Agents already use; add a narrow plugin only when Torsor must manage credentials, events, state, permission, or UI. Plugins cannot bypass kernel invariants.

Short form:

> **Derive from the Torsor design charter: the platform provides capabilities and boundaries, Agents judge and act, Humans retain control; preserve a minimum kernel, semantic closure, Agent-native concurrency, Provider-neutrality, traceability/recovery, and projection-oriented UX.**

## 35. Run Workbench

### 35.1 Definition

`Run Workbench` is a Human-facing work-site view, not a domain object:

```text
Run Workbench
├─ home Channel / Thread
├─ Run and RunInput
├─ Agent Message
├─ Run Activity Stream
├─ ProviderAttempt
├─ Worktree / Files
├─ TerminalSession
└─ Artifact
```

UI may call it `Workspace`, but the domain must not add another Workspace overlapping Project, Run, and Worktree.

### 35.2 Entry points

1. A Human opens it from a Run card in the Thread.
2. Header shows Agent, Run state, Project, home Channel, Worktree generation, and Provider state.
3. Every view retains a route back to the source Channel/Thread.
4. One Client Window may open multiple Workbenches.
5. Different Client Windows keep independent current Tabs.

### 35.3 Recommended views

```text
Conversation  - Thread context and direct Send-to-Run
Live          - typed Agent activity timeline and fixed Run composer
Files         - Run Worktree files and changes
Terminal      - observe or control TerminalSession
Artifacts     - commits, patches, reports, and logs
Activity      - Run, ProviderAttempt, Lease, and state timeline
```

Tabs are Client view state.

This slice exposes finalized report digest, length, media type, and Run/Thread provenance through existing Run/Thread Artifact projections, with authorized HTTP downloads. Unfinalized Provider text, staging files, and orphan blobs must not appear as published Artifacts. Missing/tampered storage, permission changes, and download failures fail explicitly rather than returning an empty success. New Artifacts UI, a GitHub state machine, Worktree execution, a generic plugin marketplace, and ArtifactInput are outside this slice.

Initial pages, historical backfill and live replacements obey the current scope in section 23.2; another Run's same-Thread reports must not enter an Agent's lists or counts. A filtered checkpoint advances only the recovery cursor, never synthesizing report items or resetting Timeline/Composer. Changing authenticated scope must not retain the previous scope's projections.

`Live` is a chronological engineering record:

```text
Human RunInput
Agent user-visible output
Tool started / completed / failed
File change
Provider or delivery status
Artifact / external reference
Run completion
```

Compress state, generation, Pending inputs, child Runs, and diff stats into header or expandable summary rather than occupying the main reading surface.

The production Web Live Agent Timeline first projects existing durable facts: visible deltas, public status, RunInput, ProviderAttempt, and explicit terminal Run state. The timeline is the main reading surface; Activation diagnostics may collapse. Preserve source Thread navigation, narrow viewports, and keyboard accessibility. This slice does not change the Human Run Composer or fabricate Tool Call or file events without a producer.

## 36. Human direct Send-to-Run

The Workbench composer is not private Provider input. It performs:

```text
send_to_run(
  run_id,
  message_body,
  expected_run_revision
)

→ create a Human Message in the Run's home Thread
→ create a RunInput referencing that Message revision
→ increment Run revision
→ schedule Provider delivery or the next Activation
```

1. The Message is visible to other Thread participants.
2. RunInput records `assigned_by_principal_id = Human`.
3. Do not create target-Agent Attention because the Human chose the Run.
4. Mentions of other Agents may still create Attention atomically.
5. Terminal Runs reject Send-to-Run and offer Successor creation.
6. Without real-time Steer, RunInput remains Pending while UI immediately shows it was added.
7. Message and RunInput succeed or fail together.
8. Web uses the existing `POST /api/v1/commands/send-to-run` with `idempotencyKey`, `runId`, `body`, and required `expectedRunRevision`. The Run determines the destination Thread and Agent; do not substitute ordinary Reply or direct Provider input.
9. One submission identity fixes the Human Principal, Run, body, revision, and idempotency key. Preserve it across lost responses, network errors, unreadable responses, or uncertain server outcomes. Recover by retrying the identical request, never guessing with a new revision or key. Idempotent replay returns the original result even after the Run advances or becomes terminal.
10. Current-credential failure requires reauthentication while preserving the draft and submission identity; recovery requires the original Human Principal. A delayed `401` from obsolete credentials must not clear a replacement session and may retry the original request with replacement credentials for the same Principal. Authentication/authorization rejection during recovery cannot prove that an earlier unknown submission did not commit.
11. Definite stale-revision or terminal-Run transaction rejection creates neither half. Preserve the draft and refresh facts for Human judgment; never automatically change revision and resubmit. Terminal Runs disallow new submissions. If Successor creation is not implemented in the Client, explicitly mark it unavailable and direct the Human to request follow-up in the public Thread rather than offering a false action.

```text
@Agent
= ask the Agent to choose create, continue, Fork, or Ignore

Send-to-Run
= the Human has selected this line of work
```

## 37. Streaming Output

### 37.1 Not a Message

Agent streaming output is runtime activity, not automatically a Thread Message:

```text
Provider token/delta
→ RunActivityEvent
→ Workbench Live view
```

Create a durable Message only when the Agent calls `reply` or an adapter has an explicit final-public-response mapping.

The current ACP adapter persists `agent_message_chunk` through the capability bridge's `AppendRunActivity` before it enters the timeline. Deltas, status, Provider turn end, HTTP reads, and SSE replay must not automatically publish a Message, dispose RunInput, or complete a Run.

### 37.2 RunActivityEvent

This is a runtime record, not a new collaboration object:

```text
run_id
activation_id / provider_attempt_id
sequence
kind
timestamp
payload reference
retention class
```

It may include user-visible assistant delta, tool start/completion/failure/cancellation, public RunInput delivery update, file-change summary, Artifact/external reference publication, status, provider reconnect, delivery retry, and terminal output reference.

Activity identity and order use server-assigned `id` and monotonic per-Run `sequence`, not timestamps, HTTP response order, or SSE arrival order. SQLite activity insertion, sequence allocation, and public invalidation events commit atomically. The Run projection defaults to the latest 100 items, not complete history. `ListActivity` / the HTTP activity API has bounded pages with exclusive `afterSequence` for forward reads and exclusive `beforeSequence` for historical backfill. Backward pages still return ascending sequence order, with `nextCursor` pointing to the page's earliest sequence. With both bounds, read forward within the finite interval. Each explicit client history load reads at most 100 items.

### 37.3 Safety boundary

1. Do not display or persist hidden chain-of-thought.
2. Display only Provider-marked user-visible output and tool activity.
3. Streaming output cannot change authoritative Run state.
4. Reconnect resumes by `sequence` within the retention window.
5. Retain final Messages, Artifacts, and audit facts long-term; raw token streams may be GC'd.
6. A streaming draft may link to its final Message but remains a separate fact.
7. A Tool Call uses one stable call ID whose Started/Completed/Failed/Cancelled state updates one timeline item.
8. Auto-follow only while the Human remains at the bottom; otherwise show a return-to-latest control.
9. Tool Calls default collapsed while status stays visible; details open on demand.
10. UI may show explicit public plans, status explanations, and Provider-marked user-visible reasoning summaries, but not hidden chain-of-thought.
11. SSE invalidates projections; it is not activity content or state authority. Clients read durable facts through authenticated HTTP, deduplicate activity identity, order by sequence, and retain loaded history across replay, duplicate/out-of-order notifications, and reconnect. Fill gaps between the loaded tail and a new window in pages of at most 100 with a fixed upper bound, never chasing an indefinitely growing head.
12. Background refresh must not unmount the timeline or steal focus. Appends preserve the reading position after the Human scrolls upward; prepending history preserves the visible item and its relative position. `Back to latest` explicitly resumes following. Switching Runs resets that view's history, errors, and follow state; late responses from an old Run/session cannot populate the new view. Narrow-viewport drawers cancel deferred focus operations on transitions or unmount and must not steal focus already chosen by the Human inside the drawer.
13. History failures are visible and retryable, without clearing loaded items or presenting unknown history as complete. Authentication, cross-window session updates, authorization scope, and revision fencing apply to every backfill request.
14. Composer paired refreshes and standalone Run refreshes use the same timeline-history merge rules, never replacing loaded history with the latest 100 items. Run refresh ownership includes bounded gap reads and remains independent of the Thread read. Preserve earlier-history backfill completed before the paired result is published. A gap-read failure follows the paired-read failure semantics in section 44.2 without changing acknowledged receipts, recovery identities, another Run's draft, reading anchors, or follow state.

## 38. Files

Files Tab is a Worktree read projection, not a File domain object.

### 38.1 Root and identity

Root it at the current Run Worktree or read-only Project snapshot; never expose arbitrary Host
paths. Runtime uses a registered opaque handle, not a Provider-supplied cwd.

### 38.2 Path safety

Platform file operations reject absolute paths, `..`, traversal using either separator,
symlink/junction/reparse aliases, and escapes. Validate canonical containment and directory
identities along the path. Exclusive creation of the fixed probe file never follows an existing
symlink or overwrites a file or hard link. Path checks are not an OS sandbox: this slice
requires a trusted Host-controlled private root without concurrent external renames or link
replacement; do not enable the executor without that precondition. Hostile same-user TOCTOU
protection requires later OS handle-relative/containment support.

### 38.3 Read projection

Humans may inspect files and diffs during Agent work. Reads carry Worktree generation, path,
and content hash; Clients may report changes and refresh. This slice adds no Files API/UI.

### 38.4 Write authority

MVP Files Tab is read-only by default. Human edits require current Writer Authority or a separate
derived Worktree. Platform-mediated writes follow §22: stale tokens/generations, stop-requested
executions, and quarantined directories must fail. File contents neither grant execution
authority nor automatically confirm Run completion.

## 39. TerminalSession

### 39.1 Definition

Terminal is a runtime resource with persistent identity:

```text
TerminalSession
- origin_run_id
- initial_working_directory
- creator_principal
- process identity
- status
- controller lease
- output sequence
```

A Tab is only a view. Closing it need not stop the Session, and multiple Clients may observe one Session.

### 39.2 Full Human control

`New Terminal` starts a full interactive Human Shell.

1. Torsor does not parse, filter, or restrict Human commands.
2. A Human may edit/create/delete files, run programs, start background processes, use Git, or leave the initial directory.
3. Terminal uses the Human's OS permissions and does not inherit long-lived Agent credentials.
4. From a Workbench, initial cwd is the Run Worktree; `origin_run_id` records provenance but does not constrain the process.
5. Terminal behavior does not automatically become Message, RunInput, Artifact, or Run state.
6. Torsor may audit create/close/control changes without retaining complete command/output history.

### 39.3 Human-Agent write handoff

Opening a full Terminal in a Run Worktree:

1. Gives the Human Writer Authority.
2. Requests Agent write stop and revokes Agent Writer Lease.
3. If stop is unconfirmed, UI reports concurrent-write risk; the Human may still force takeover.
4. The Human may open multiple Terminals while in control.
5. A later Agent Activation must reread Git/filesystem state.
6. Record `human_intervention` for provenance.

Writer Authority coordinates ownership; it does not restrict Human command power.

### 39.4 Writer Authority

```text
one Worktree generation
→ one automated Writer Authority at a time
```

```text
holder_kind = agent_activation | human_principal
holder_id
fencing_token
```

A Human is the highest authority. Force takeover revokes Agent authority and honestly reports unstopped external processes; it must not claim a safe rollback that did not occur.

### 39.5 Terminal input concurrency

1. Multiple Clients may observe one TerminalSession.
2. Only one Client holds the controller lease at a time.
3. Controller lease prevents interleaved input to one process; it does not limit other Terminals.
4. Process exit does not complete the Run.
5. A Human Terminal may outlive and modify files after terminal Run state; those changes do not alter or belong to that Run automatically.

## 40. Workspace action mapping

| Workbench action | Torsor semantics |
|---|---|
| New Agent | Select an Agent and create Attention or an explicit new Run/Fork/Review Run |
| New Terminal | Create a full Human TerminalSession with unfiltered commands and initial cwd at the Run Worktree |
| Files | Open the current Run Worktree Files view |
| Agent output | Subscribe to the RunActivityEvent stream |
| Copy workspace path | Only a trusted local Client sees a Host path; a remote Client uses a logical Run link |
| Import session | Provider/conversation import is an adapter capability and does not change Message/Run semantics |
| Show setup | Display Project/Worktree provisioning Activity and logs |

Terminal profile is Client/runtime configuration, not a collaboration object.

## 41. Effect on kernel completeness

### Promoted to MVP

1. Human `send_to_run`.
2. `assigned_by_principal_id` supports Human and Agent.
3. Writer Authority supports Agent Activation and Human Principal and records Human intervention.

### Added runtime records

1. `RunActivityEvent`.
2. `TerminalSession`.
3. Terminal controller lease.

### Not domain objects

- Workspace.
- Tab.
- Pane.
- File.
- Agent draft.
- Streaming Message.

The Workbench therefore preserves Channel/Thread provenance, durable Runs, Worktree single-writer enforcement, Provider-neutrality, independent Client views, and separation of Message from runtime stream.

## 42. Desktop collaboration: Conversation Dock, Thread Workspace Tree, and Split Panes

### 42.1 The problem is context replacement

Page replacement along `Channel → Thread → Run Workbench` hides the Root Message, later Replies, sibling Runs, and Worktree relationships while a Human watches execution. Desktop UI should project the source relationship in adjacent surfaces:

```text
Global navigation
├─ Channel / Thread selection
├─ Conversation Dock
│  ├─ Root Message
│  └─ Thread Replies
└─ Thread Workbench
   ├─ Project / Worktree tree
   └─ split panel canvas
```

The domain source relationship remains unchanged.

### 42.2 Conversation Dock

It persistently shows home Channel, Root Message, Replies, Reply composer, and lightweight Message-to-Run/RunInput/Artifact provenance. Opening Files, Terminal, or Live does not replace it. Collapse is Client view state only. This keeps the original request and new Replies visible beside execution.

### 42.3 Thread Workspace Tree

```text
Project torsor
├─ Worktree generation 04
│  ├─ Sable · Run R184
│  │  ├─ Agent activity
│  │  └─ Artifacts
│  ├─ Files
│  └─ TerminalSession pwsh-1
└─ Worktree generation 01
   ├─ Keel · Run R185
   │  └─ Review activity
   ├─ Files
   └─ TerminalSession pwsh-2
```

`Workspace` is a Human-facing name for a Worktree generation, not a domain object.

1. Independent writing Runs use separate Worktrees by default.
2. Agent, Files, Terminal, and Artifact Tabs in one Worktree do not imply multiple automated Writers.
3. Multiple Agent nodes sharing a Worktree must be read-only or Activations of one Run; they cannot bypass Writer Authority.
4. A file node opens a Tab identified by `worktree_generation + path + content_hash`.
5. Agent opens Live/Activity; Terminal opens its TerminalSession.

### 42.4 Split Pane Canvas

Support split right, split down, move active Tab, close Tab/Panel, collapse Conversation Dock, collapse Workspace Tree, and reset layout. These remain local Client view state in MVP.

Opening multiple Panes does not duplicate facts: File Tabs observe content revisions, TerminalSession retains one controller lease, Live subscribes to RunActivityEvent, and Conversation subscribes to Thread cursor.

### 42.5 Charter alignment

The design adds projections rather than domain objects; exposes provenance; leaves layout to Client and invariants to Torsor; supports concurrent Runs; consumes Provider-neutral activity; keeps source conversation present; preserves safe failure; and treats trees, Tabs, Panes, and layout as views.

### 42.6 Global Activity Center

Activity is a projection across Threads, not a Task object. It aggregates Attention, Run/RunInput, RunActivityEvent, ProviderAttempt, Worktree conflict, Artifact, and Human intervention.

Group by Human need:

1. **Needs you:** decisions, conflicts, permissions, failures, and confirmation.
2. **Running:** active Runs across Projects, Channels, and Threads.
3. **Recently changed:** new Messages, state, and Artifacts.
4. **Completed:** recent completion, collapsible by time.

Every item links to:

```text
Project → Channel → Root Message / Thread → Run (when applicable)
```

Activity does not replace Channel or become assignment truth, does not flood Humans with raw token/tool events, prioritizes change/need/source, and returns collaboration to the Thread.

### 42.7 Default MVP desktop layout

```text
┌────┬──────────┬────────────────┬──────────────┬─────────────────────┐
│Rail│ Channels │ Conversation   │ Workspaces   │ Split Pane Canvas   │
│    │ Threads  │ Root + Replies │ Project tree │ Live / File / Term  │
└────┴──────────┴────────────────┴──────────────┴─────────────────────┘
```

- Rail is fixed and narrow with Channels, Activity, and Agents.
- Channels is collapsible.
- Conversation and Workspaces default open and are collapsible.
- Canvas receives remaining space and supports horizontal or vertical split.

Important provenance is visible by default; the Human collapses it when space is needed rather than navigation replacing it.

```text
Full context
Rail | Channels | Conversation | Workspaces | Run Canvas

Thread collaboration
Rail | Conversation | Workspaces | Run Canvas

Run focus
Rail | Workspaces | Run Canvas
```

1. Channels may collapse while Root Message and Replies remain.
2. Channels and Conversation may collapse together for Run focus.
3. Workspaces may collapse independently.
4. A clear restore action remains visible.
5. Collapse is local view state; Message, Attention, and RunInput continue arriving.
6. With Conversation collapsed, Run Header still shows source Channel/Thread and restores context in one action.

### 42.8 Still outside the kernel

- Conversation Dock.
- Activity Center.
- Workspace Tree.
- Editor Group.
- Split Pane.
- Tab.
- Panel layout.
- Panel collapse state.

They are rebuildable projections of existing domain facts and runtime resources.

## 43. Platform position and Agent-directed integration

### 43.1 Torsor's role

Torsor is not a project manager, central scheduling brain, or fixed workflow engine:

```text
Human / Agent     work actors
Prompt            work method and responsibility
Torsor            collaboration, execution infrastructure, facts, boundaries
Provider          model execution capability
GitHub etc.       external hosting, CI, protection, final resource state
```

Torsor does not decide whether a Message deserves action, whether to continue/create/Fork/replace/Ignore, whether another Review is needed, when work is semantically complete, or whether to Reply, publish, create a PR, or ask a Human.

Torsor guarantees unforgeable identity/capability, provenance to Message/Run/Worktree, one automated Writer per Worktree, revision/idempotency/Lease/fencing/terminal protection, durable failure/conflict/late/external-operation facts, and Human observation/guidance/takeover/stop.

These are platform contracts, not claims that OS containment already exists. The first
lease-backed physical execution slice connects only Kernel, Runtime, and a controlled Worktree
executor; physical identity and stop evidence exist independently of logical leases. This
optional tracer is disabled by default. It exposes no ACP native shell/write tools and implements
no Human Terminal/controller lease, Files UI, GC, or GitHub integration. Without safe isolation
evidence, retain an unusable quarantined directory instead of widening execution authority.

### 43.2 PR and real integration

A typical implementation Agent Prompt may require:

```text
After completing the change and validation:
1. inspect the complete diff;
2. push the branch;
3. create a PR;
4. report the PR and validation in the source Thread;
5. complete this Run after PR creation succeeds.
```

```text
Thread Message
  → Agent creates Run and exclusive Worktree
  → Agent changes, validates, and reviews
  → Agent judges Prompt completion
  → Agent calls PR capability
  → Torsor records result and external reference
  → Agent replies in source Thread
  → Run Completed
```

If the Prompt requires ownership through merge, the Run remains until merge succeeds, external rules reject it, Human intervention is required, or the Agent fails/cancels.

```text
create PR    submit an integration proposal
merge PR     enter the target branch
```

Torsor does not hard-code who merges. Agent Prompt, capability scope, and external protection rules decide.

### 43.3 Minimum durable facts

Do not copy a complete GitHub PR state machine. Record at least:

```text
actor principal
source Run
source Worktree generation
source commit
action type
target repository / branch
idempotency key
operation result
external reference
timestamp
```

Audit, RunActivityEvent, Artifact, and external references may carry these facts. GitHub remains authoritative for live PR state.

### 43.4 Next design question

The remaining question is how a Run expresses and proves completion of its current Prompt across investigation report, code plus local validation, Artifact publication, PR creation, CI success, merge, or deployment.

Current MVP conclusion:

1. Do not add `CompletionDeclaration`.
2. Use explicit idempotent `complete_run`.
3. Agent judges semantic completion from the effective Prompt.
4. Torsor verifies permission, revision, RunInput disposition, and reference ownership.
5. Humans understand results through final Message, Artifact, external reference, and Activity projection.
6. Consider a small expected outcome only if real recovery/audit stories prove existing facts insufficient.

## 44. Agent Timeline, Run Composer, and external extension

### 44.1 Agent Timeline projects RunActivityEvent

```text
Run source
├─ Human RunInput
├─ Agent visible output
├─ Tool Call
│  └─ command / input / output / error / diff
├─ File or Artifact change
├─ Provider and delivery status
└─ explicit Run completion
```

Timeline items expose source type without becoming domain objects. Stable history and active streaming head may use separate transport and compose into one timeline.

Each activity shows source type, original kind, per-Run sequence, timestamp, and available Activation/ProviderAttempt provenance. Known visible deltas and status use focused plain-text presentation. Unknown kinds show only a generic activity marker and provenance metadata: never execute HTML or infer/expand an unknown payload. RunInput and ProviderAttempt use current projection facts, timestamps, and their own identities without fabricated RunActivityEvent sequences. Keep semantic input disposition separate from Provider delivery. Run `Active` is not Provider running; Provider `Completed` is not Run completion. Run `Completed`, `Failed`, and `Cancelled` come from authoritative Run state and revision. If a cancelled Run still has a `Started`, `Acknowledged`, or `Unknown` ProviderAttempt, explicitly show that stop is unconfirmed.

### 44.2 Run Composer

Each Agent Run Pane has a fixed composer showing the target:

```text
Send to Sable · R184
Also published in #torsor-core / current Thread
```

It uses atomic `send_to_run` from section 36 independently of Live Timeline implementation.

1. Show target Agent name and ID, full Run ID, observed revision, and the explicit public home Channel/Thread destination with a return action.
2. Show `Submitting` and prevent duplicate submission. Do not insert optimistic Message or RunInput into committed projections. Success confirms both committed and refreshes Thread and RunInput facts; a read failure only means projections need refreshing, not that the acknowledged commit failed.
3. A definite transaction rejection reports the reason and that neither committed. A structured `413/payload_too_large` with `requestId` received before command execution on the initial attempt, with no prior unknown outcome, is also a definite rejection: release the recovery request identity, retain an editable draft, and let the Human shorten or replace the body and send again with a new idempotency key. Revision conflict preserves the draft and requires refresh and another Human send; terminal rejection must not fall back to ordinary Reply.
4. Lost responses and other uncertain outcomes show `Submission outcome unknown`, never `Not submitted`. Freeze the original request and offer `Retry same submission`. If the prior outcome is unknown, authentication/authorization failures or `413/payload_too_large` during retry preserve uncertainty and the original request identity until same-identity idempotent replay confirms the outcome. Rejecting a later request before command execution cannot establish that the earlier request did not commit.
5. Retain per-Run drafts and recovery identities as local state of the current Client Window across panel closure, Run selection, background refresh, and reauthentication. Late results update only their own Run's submission, never clear another Run's draft or navigate back. This slice does not promise draft recovery after browser reload or process exit.
6. Committed does not mean the Provider received, accepted, or incorporated the input. Do not show `Delivered` or `Accepted` without public delivery evidence; display RunInput disposition separately. Unknown real-time Steer capability must explicitly disclaim immediate delivery without disabling durable RunInput submission.
7. Provide labels, perceivable pending/success/error states, visible focus, and keyboard submission/recovery. Enter inserts a newline; Ctrl/Cmd+Enter explicitly submits without interfering with IME. Async outcomes must not steal focus from another Run or control. On narrow viewports, destination, body, status, and actions must wrap/scroll and remain keyboard-accessible.
8. Explicitly explain absent/mismatched Run projections, unavailable authentication, terminal state, and unimplemented Successor/real-time control capabilities. Never present clickable no-op actions.
9. Thread and Run reads own their replacement, loading, and error state independently. A paired refresh must not discard a still-current half through a shared freshness predicate. A single or paired replacement takes over only its own projection; the remaining current half must complete or explicitly fail. Replacement failure propagates to waiters; old responses must not clear loading, errors, or facts for a newer selection, Session, or Project. Publish both halves together when both remain current and succeed; if both remain current but either read fails, retain the original projections, settle loading, and allow read retry.
10. Failure of either projection read after an acknowledged commit must expose a perceivable `Committed; projections could not be refreshed` inside that Run's Composer, including narrow-screen modals, not only in inert content outside the modal. The existing Composer refresh action retries reads only, never the command. Retain the acknowledged request's idempotency identity and receipt separately from unconfirmed recovery identity; refresh failure must not turn a committed submission into unknown or a retryable command. Scope refresh state by Run and attempt and retain it across pane remounts; older refresh results must not overwrite newer refreshes or steal Human focus.

### 44.2.1 Human Cancel and Withdraw controls

1. Production Human Web Run detail exposes `Cancel Run` and per-input `Withdraw Input`. Only `Active` / `Waiting` Runs are cancellable; only a `Pending` RunInput belonging to the selected Run and assigned by the current Human is withdrawable. Missing matching projections, refresh in progress, missing authentication, terminal Runs, other assigners, and settled inputs have no executable new action and explain why. The server remains authoritative for permission and eligibility.
2. Reuse the Run Composer request, idempotent replay, authentication recovery, receipt, and projection-refresh state machine, not a separate retry protocol. Call existing `cancel-run` / `withdraw-run-input` with the observed Run revision and, for withdrawal, disposition revision. Use the current session/CSRF and fixed public reasons `Cancelled by Human from Run controls.` / `Withdrawn by Human from Run controls.`; do not edit or delete Messages.
3. Freeze each operation's target, revisions, reason, and idempotency key before requesting. Double clicks or repeated keyboard activation cannot create a second request. Lost responses, unverifiable receipts, and uncertain server failures display `Outcome unknown` with explicit `Retry same action` only. Even after refresh shows a terminal Run or settled input, allow original-identity replay to confirm its outcome; projections are not receipts for that request.
4. Definite stale-revision / conflict rejection retains the reason and requires refresh and review before the Human explicitly starts a new operation; never automatically resend with a new revision. Initial definite permission rejection must not claim success. Authentication or CSRF failure requires reconnecting; permission or authentication failure after an unknown outcome preserves uncertainty. Only the original Human may recover a request, never another identity. Targets already cancelled or settled by another request show current durable facts without duplicating logical effects.
5. Scope action state by Run and input identity across pane closure, Run switching, and reauthentication. Window `sessionStorage` retains only these controls' recovery metadata and acknowledged receipts (target IDs, principal ID, revisions, key, fixed reason), not message bodies, credentials, CSRF, Provider payloads, or error text. Reload treats in-flight requests as unknown; reopening reads durable projections without automatic resubmission. Unavailable storage or corrupt recovery data explicitly disables new control commands instead of discarding an unknown identity and resending. This does not extend Composer draft reload guarantees.
6. Success or confirmed same-identity recovery refreshes the Run, home Thread, and existing Timeline history without fabricated events or optimistic dispositions. Read failure after acknowledged commit displays `Committed; projections could not be refreshed` inside Run controls, retains the receipt, and provides read-only refresh, never command resubmission. Late reads from old Runs / Sessions cannot replace the current selection or steal focus.
7. Always distinguish logical `Cancelled`, asynchronous stop requests, physical `StopConfirmed`, and Worktree quarantine. Success confirms logical cancellation only; ProviderAttempt settlement, cancel acknowledgement, terminal Run state, or lease revocation is not physical-stop evidence. The current public Run projection exposes no physical execution / quarantine facts: explicitly state that confirmation is unavailable here, without claiming safe Worktree release or actual quarantine. Preserve existing Provider stop-unconfirmed notices. This slice adds no physical controls, quarantine release, or Trusted Local execution.
8. Use named native buttons supporting Tab, Enter, Space, visible focus, disabled / busy states, and perceivable status / error regions; withdrawal labels include input sequence and ID. Recovery and read-only refresh remain accessible inside narrow-screen modals without asynchronous focus theft. Deterministic controller and rendered tests cover success, eligibility, repeated activation, lost response, revision / conflict, permission / CSRF / session expiry, reload / reopen, and logical cancellation with unconfirmed physical stop or quarantined Worktrees.

### 44.2.2 Human Message revision controls

1. Conversation exposes `Edit message` and explicitly confirmed
   `Delete message` only for a non-tombstoned Message originally authored by
   the current Human. Other Human and Agent Messages are read-only. Hiding the
   Client action does not replace server-side author checks.
2. Edit initializes from the observed latest revision and submits the complete
   body, Mention set, and `expectedMessageRevision` to `edit-message`. Delete
   submits the observed revision to `delete-message`. Confirmation states that
   the Message becomes a tombstone while history, Attention, and RunInput
   references remain and are not cancelled.
3. Freeze Message ID, expected revision, body/Mentions when applicable, and
   idempotency key before sending. Disable repeated activation while pending.
   Lost or unverifiable responses show `Outcome unknown` and only retry the
   same request. Definite stale/permission/conflict results preserve the edit
   draft or delete intent; after refresh the Human reviews and creates a new
   request rather than automatic revision replacement. If an earlier outcome
   is unknown, a retry receiving 401 or invalid CSRF retains the frozen request
   and unknown state across the SessionGate. After the same Principal
   reauthenticates, the control restores the original body/revision/key and
   permits only same-identity replay. A definite 4xx without prior uncertainty
   remains a definite rejection rather than becoming unknown.
4. Success or same-identity replay confirmation refreshes the Thread without
   optimistic revision, tombstone, Mention, or Attention facts. A failed read
   after acknowledged commit shows `Committed; projections could not be
   refreshed` and retries reads only. Late old-Thread or old-Session results
   cannot replace current selection or focus.
5. Message bodies are not Client recovery logs. The current Window may retain a
   frozen request in memory across authentication recovery, but bodies,
   credentials, and CSRF never enter public events, command receipts, or
   persistent recovery metadata. Authentication/authorization failure after an
   unknown outcome preserves uncertainty until same-Principal idempotent replay
   confirms it.
6. The body shows the latest revision by default; tombstones use a perceivable
   placeholder. `Revision history` expands revisions in order with number,
   time, body or tombstone, and Mentions, without treating history as the
   current editable draft. Controls remain keyboard, focus, confirmation, and
   narrow-viewport accessible.

### 44.2.3 Human Agent config and Run adoption controls

1. Agents view shows the current Agent config revision and non-secret JSON
   configuration, with `Update config` for an authenticated Human. It submits
   the complete config and observed `expectedAgentConfigRevision` to
   `update-agent-config`. Success creates the next immutable revision without
   modifying existing Runs.
2. Run detail shows the Run's pinned revision and owner Agent's current
   revision. `Adopt current config` exists only for a nonterminal Run with a
   higher current revision, submitting observed `expectedRunRevision`,
   `expectedAgentConfigRevision`, and that current target revision to
   `adopt-run-config`. Running Activations explicitly remain on their recorded
   revision; success affects later Activations only.
3. Both operations freeze target, expected/target revisions, request body for
   update only, and idempotency key. They reuse `Outcome unknown`, `Retry same
   action`, same-Principal authentication recovery, explicit refresh/review
   after conflict, and read-only refresh after acknowledged commit. Never
   auto-adopt a newly observed revision or silently rewrite a stale target.
   If an unknown update/adoption retry receives 401 or invalid CSRF, the
   SessionGate and reauthenticated control continue to show the unknown
   outcome and restore the byte-identical request/key from current-window
   Controller memory. A definite 4xx without prior uncertainty still releases
   that request identity.
4. Config bodies never enter public events, command receipts, error text, or
   persistent Client recovery metadata. The current Window may retain an
   unknown update request in memory for same-identity replay. After browser
   reload, if the complete original request is unavailable, report that it
   cannot be recovered instead of guessing a new key. Adoption recovery
   metadata contains only public IDs, revisions, and key.
5. Successful update refreshes Agents/bootstrap projection. Successful
   adoption refreshes the Run, Run list, and source Thread. Read failure does
   not revoke the receipt or resend the command. Native buttons, JSON input
   labels, error regions, busy/disabled states, keyboard behavior, and narrow
   viewports remain accessible.

### 44.3 Tool Call expansion and failure

Collapsed timeline examples:

```text
Read src/workbench.ts          completed
Edit src/workbench.ts          running
Shell npm test                 failed
```

Expansion reveals arguments and cwd, truncated output, changed files or diff summary, error and retry/replace result, and ProviderAttempt or TerminalSession provenance. Running, failed, and cancelled remain distinguishable while collapsed. Expansion is Client view state.

This Tool Call lifecycle is a requirement for a later producer capability, not permission to enable ACP native tools in this Live Timeline slice. The current adapter stays deny-by-default. Do not parse text deltas as tool execution or synthesize Tool Calls. Existing Provider running/failed/Unknown and Run failed/cancelled facts remain distinguishable without expansion, with details available on demand.

### 44.4 External capability and plugin boundary

```text
Agent can call it directly and Torsor needs only the final reference
→ use the Agent's existing CLI, API, or MCP; no Torsor plugin

Torsor must manage credentials, authorization, events, live state, or dedicated UI
→ use a narrow plugin interface
```

Plugins may adapt Provider, Runtime, GitHub, Storage, or Notification, but:

1. They cannot bypass Principal, revision, idempotency, Lease, or provenance.
2. Results return as existing RunActivityEvent, Artifact, external reference, or audit facts.
3. MVP needs only a static or configuration-loaded internal adapter seam.
4. Do not build a marketplace, dynamic download, hot reload, complex dependency resolution, or third-party sandbox yet.
5. Extract a public plugin SDK only after a second real integration proves common requirements.

### 44.5 Desktop UX scenarios requiring verification

The prototype and evidence cover at least:

1. Channel, Root Message, Replies, Workspaces, and Run visible together.
2. Collapse only Channels while Conversation remains.
3. Collapse Channels and Conversation to focus multiple Agent Runs.
4. One Agent streaming Timeline with collapsed and expanded Tool Calls.
5. Running, completed, and failed Tool Call states.
6. Run Composer atomically creates public Thread Message and RunInput.
7. Two Agents in one Thread work side by side in different Worktrees.
8. Conflicting file changes remain separate immutable Artifacts and are coordinated explicitly.
9. Failed Run, Replacement Run, Abandoned/Reassigned input, and late output.
10. A read-only investigation Run has no write capability.
11. Human Terminal takes Writer Authority without Torsor filtering commands.
12. Recursive Agent delegation reaches depth or budget limits.
13. Activity Center aggregates across Threads and links back to source Thread/Run.
14. One stable Agent identity owns independent concurrent Runs across Threads.
15. Multiple Clients share server facts but keep independent Panels, Tabs, drafts, and scroll positions.

## 45. Public working quick start

The public repository must provide a repeatable minimum vertical path from a
clean checkout so a first-time contributor on supported Node.js can verify the
working MVP without model credentials or network access.

1. The root README provides the supported Node.js version plus `npm ci`,
   focused validation, full CI, synthetic Host, minimum HTTP journey, Web
   development/static preview, and ACP mock commands. Commands are copied from
   the repository root; Windows PowerShell is an explicitly verified
   environment, with portable paths where practical.
2. The quick-start bootstrap is a committed, complete, machine-independent
   JSON file containing at least a Human Principal, Runtime Principal, Agent
   Principal and matching Agent configuration, Project, and Channel, using
   synthetic data only.
3. The credential-free Host is a separate example/development entry point. It
   uses the production composition path through public
   `createLocalRuntimeHost` and `DeterministicFakeAdapter`, accepts only the
   explicit IPv4/IPv6 loopback literals `127.0.0.1` or `::1`, rejects wildcard,
   non-loopback addresses, and hostnames, does not switch the production CLI
   through an environment flag, and does not enable arbitrary adapters,
   commands, tools, or relaxed permissions.
4. The minimum HTTP journey actually verifies `/health`, bearer exchange for
   an HttpOnly session cookie, session CSRF, Project bootstrap, `start-thread`,
   the resulting Run, Run activity, and terminal completion. A checked script
   obtains dynamic IDs from responses instead of hard-coding them in prose.
5. Normal Host shutdown closes HTTP, Runtime, and Kernel. Restarting with the
   same state directory keeps the completed Thread, Run, and activity
   readable. The example CLI provides an explicit opt-in `--shutdown-stdin`
   control that accepts only a `shutdown` line and invokes the same close path
   as signal handling; shutdown must finish and exit with status 0 before
   reporting success. Tests use that cooperative path as normal-shutdown
   evidence rather than treating forced termination as graceful shutdown.
   Tests use isolated temporary directories and dynamic ports and leave no
   processes, ports, databases, or generated files behind.
6. Server workspace commands run with `apps/server` as their current working
   directory. Component documentation states that semantic explicitly and
   uses bootstrap, database, and Artifact paths that resolve correctly from
   that cwd; the root quick-start example resolves its own default state from
   the repository root.
7. The root `dev:web` and `preview:web` wrappers select the `@torsor/web`
   workspace and forward Vite arguments supplied after `--` intact to the
   workspace script. The Web development server may explicitly proxy `/api`
   and `/health` to the local Host. Static preview may provide the same local
   smoke proxy, but must be described as local preview rather than a
   production reverse proxy or deployment promise.
8. Every consumable public package includes a byte-identical copy of the
   repository Apache-2.0 `LICENSE` in `npm pack --dry-run`. Documentation and
   quick-start tests cover example files, root commands, cwd semantics, CLI
   loopback rejection/acceptance, the end-to-end journey through the real Host
   CLI and root Web wrappers, restart durability, and package license
   contents. Tests prove that the wrappers select the correct workspace and
   forward `host`, positive dynamic `port`, and `strictPort` arguments.
   Process readiness, HTTP probes, and shutdown are bounded and supervised.
   Vite does not receive zero values that it may reinterpret as defaults, and
   tests clean up after success or failure.
