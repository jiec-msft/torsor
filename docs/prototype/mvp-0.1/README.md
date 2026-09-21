# Torsor MVP 0.1 prototype

Static, dependency-free desktop prototype for Torsor's conversation-first,
Agent-native collaboration model.

The durable source relationship remains:

```text
Channel -> Root Message -> Thread Replies -> Run -> Worktree
```

The UI does not turn this into replacement pages. It projects the same facts
into independently collapsible surfaces:

```text
Rail | Channels | Conversation | Thread Workspaces | Run Canvas
```

## Run

From this directory:

```powershell
python -m http.server 4173
```

Then open `http://localhost:4173`.

## Three context modes

The top toolbar makes context reversible instead of forcing backward
navigation:

```text
Full context
Rail | Channels | Conversation | Workspaces | Run Canvas

Thread collaboration
Rail | Conversation | Workspaces | Run Canvas

Run focus
Rail | Workspaces | one or two Run panes
```

- **Channels** and **Conversation** can collapse independently.
- **Focus runs** collapses both in one action.
- **Restore context** restores both in one action.
- **Workspaces** can also collapse independently.
- Every focused Run keeps its source Channel, Thread, Worktree generation, and
  branch visible.

Useful routes:

```text
/?view=workbench&thread=mvp&layout=single
/?view=workbench&thread=mvp&layout=single&mode=thread
/?view=workbench&thread=mvp&layout=vertical&demo=agents&mode=focus
/?view=workbench&thread=mvp&layout=single&mode=focus&tree=0&tool=R184-edit
/?view=workbench&thread=mvp&layout=single&mode=thread&tree=0&runInputDemo=1
/?view=workbench&thread=recovery&run=R210&mode=focus&tree=0&tool=R210-shell
/?view=activity
/?view=agents
```

## Agent Run interaction

An Agent pane is a long-running work surface rather than a static status card:

```text
Run header and provenance
Run summary pills
Typed activity timeline
├─ Human RunInput
├─ Agent user-visible output
├─ Tool Call
├─ File or Artifact change
├─ delivery / Provider status
└─ explicit completion or failure
Fixed Send-to-Run composer
```

Included interactions:

- Expand and collapse Tool Calls while their running, completed, or failed
  state remains visible.
- Replay mock streaming output.
- Stop auto-follow when the Human scrolls away and return with **Latest
  activity**.
- Send guidance from the fixed Run composer.
- Atomically mock a public Thread Message plus RunInput.
- Keep semantic disposition `Pending` while delivery advances through
  `Pending -> Delivered -> Accepted`.
- Type `[fail]` in a Run composer to simulate an atomic send failure; the draft
  remains and neither Message nor RunInput is created.
- Reject input to terminal Runs and offer a Successor or Replacement instead.
- Open Agent, File, Terminal, and Artifact resources as tabs.
- Split right or down and move the active tab to the other pane.
- Run mock commands in a Human-controlled Terminal. The browser never executes
  real host commands.

## Projection boundary

Panel visibility, tabs, split direction, expanded Tool Calls, drafts, and
scroll position are Client view state.

Message, Attention, Run, RunInput, ProviderAttempt, Worktree generation,
TerminalSession, RunActivityEvent, Artifact, and external references remain the
durable or runtime facts.

Streaming output is not automatically a public Message. The Run composer is
the explicit bridge: it publishes a Thread Message and assigns that exact
Message revision to the selected Run.

## Ordered evidence

The evidence set mixes full desktop views with narrower close-ups so Tool Call
and Composer text remains readable when viewed on a phone.

| File | Core UX scenario demonstrated |
|---|---|
| `001-full-context-thread-and-run.png` | Channel, Root Message, Replies, Worktrees, Agent Timeline, and Composer coexist |
| `002-channel-column-collapsed.png` | Channels collapse while the public Thread remains visible |
| `003-focus-mode-single-run.png` | Channels and Conversation collapse together; source provenance remains |
| `004-streaming-timeline-and-composer.png` | User-visible streaming, completed/running Tool Calls, and fixed Run composer |
| `005-expanded-tool-call-detail.png` | On-demand Tool Call detail with files, change summary, Writer Authority, and fencing token |
| `006-failed-tool-call-detail.png` | Failed Provider attempt, abandoned input, late output, and Replacement action |
| `007-run-input-visible-in-thread-and-timeline.png` | One Human instruction appears in the public Thread and selected Run Timeline |
| `008-two-agent-runs-two-worktrees.png` | Two Agents work concurrently in separate Worktrees and split panes |
| `009-conflict-and-coordination-worktree.png` | Conflicting immutable candidates remain separate; a third Run coordinates |
| `010-failed-and-replacement-runs.png` | Failed and Replacement Runs coexist with preserved provenance and terminal-state controls |
| `011-read-only-investigation.png` | Read-only capability scope, zero writes, published report, and explicit completion |
| `012-human-terminal-writer-takeover.png` | Human Terminal has full command control and explicit Writer Authority |
| `013-delegation-budget-guard.png` | Agent delegation, child Run, depth limit, and no silent discard |
| `014-activity-across-all-threads.png` | Human-relevant activity aggregated across Threads with source paths |
| `015-agent-concurrency-overview.png` | Stable Agent identities own concurrent Runs across independent Threads |
| `016-client-a-context-layout.png` | Client A keeps the full context layout over shared server facts |
| `017-client-b-independent-focus-layout.png` | Client B views the same facts with an independent focused split layout |

## Current boundary

This prototype intentionally mocks provider execution, persistence,
authentication, Worktree integration, external tools, and multi-client
transport. It demonstrates the MVP information architecture, interaction
semantics, state distinctions, and focus behavior without adding new domain
objects for Workspace, Tab, Pane, Tool Call UI, or Composer.
