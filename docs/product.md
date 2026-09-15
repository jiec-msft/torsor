# Product Definition

## Promise

Torsor helps one person lead multiple software agents without becoming their scheduler, watchdog, or memory.

Agent sessions are replaceable. Goals, commitments, decisions, evidence, and pending actions are durable.

## Principles

1. **The human leads the work.** Agents execute, investigate, review, and report within explicit authority.
2. **Work survives sessions.** Closing every agent session must not erase the next action or accepted context.
3. **Commitments are explicit.** Chat messages do not silently become shared tasks, decisions, approvals, or results.
4. **Tasks and attempts are separate.** A task can survive failed, cancelled, retried, or reassigned runs.
5. **Uncertainty is visible.** A lost connection is not automatically success or failure.
6. **Local execution remains local.** Hosts retain control of their files, processes, credentials, and workspaces.
7. **The system continues deterministically.** Routine progression does not depend on a long-lived agent remembering to continue.

## First working slice

The first slice will demonstrate:

1. A person creates a durable workstream.
2. One agent performs a task and submits a result.
3. Another agent reviews that result.
4. Both agent sessions can be closed and recreated.
5. The next action remains available without the person repeating context.
6. The final result enters an explicit human review state.

## Initial non-goals

- Replacing general-purpose social chat.
- Keeping one coordinator agent session alive forever.
- Claiming exactly-once behavior for arbitrary external systems.
- Building every collaboration view before the first end-to-end slice works.
