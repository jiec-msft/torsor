# `@torsor/agent-runtime`

`@torsor/agent-runtime` consumes durable Kernel work and runs one provider
process for each Activation. The Kernel remains authoritative for Attention,
Run, RunInput, provenance, revisions, terminal state, and outbox delivery.

The runtime provides:

- Runtime-owned Attention claims and Activation creation.
- Ordered, leased outbox consumption with idempotent command keys.
- A provider-neutral adapter contract and deterministic fake adapter.
- A GitHub Copilot CLI ACP stdio adapter using `copilot --acp --stdio`.
- An Activation-scoped capability bridge that binds Agent identity, Run,
  Activation, ProviderAttempt, revisions, and provenance on the server side.

Provider session IDs are diagnostic only. Recovery always rebuilds provider
input from Kernel projections and never treats a provider session as
authoritative state.

The current Kernel contract does not expose lease renewal. The runtime
therefore claims one outbox event at a time and requires Attention and outbox
leases to exceed the configured provider timeout by a safety margin.

Because the Kernel outbox is globally ordered, one runtime instance consumes
the global stream. `projectIds` supplies the Projects whose existing open
Attentions are scanned at startup; Projects encountered in outbox events are
loaded dynamically.

The Copilot adapter intentionally exposes no filesystem, terminal, Worktree, or
Git integration in this slice. It asks Copilot for a validated JSON action
envelope and applies only the narrow Kernel-backed capabilities represented by
that envelope.
