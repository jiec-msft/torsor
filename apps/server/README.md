# `@torsor/server`

`@torsor/server` provides the production local host for Torsor. The host owns
one `@torsor/kernel` SQLite connection, exposes it through the local HTTP and
durable Server-Sent Events service, and runs `@torsor/agent-runtime` against
that same Kernel.

Startup binds the HTTP listener only after configuration and the database have
opened successfully. Shutdown stops accepting HTTP work, waits for the current
bounded Runtime pass, and then closes the Kernel. Startup, Runtime-loop, and
shutdown failures reject the host lifecycle and make the executable exit
unsuccessfully.

The Runtime loop yields to the event loop after each busy pass and rechecks
shutdown before continuing. Idle polling uses one interruptible timer whose
shutdown listener and timer are removed as soon as either side completes.

Build the workspace, then start the host with a local Human credential and a
Runtime principal:

```powershell
$env:TORSOR_DATABASE_PATH = ".torsor\torsor.sqlite"
$env:TORSOR_BOOTSTRAP_PATH = ".torsor\bootstrap.json"
$env:TORSOR_AUTH_TOKEN = "replace-with-a-local-secret"
$env:TORSOR_PRINCIPAL_ID = "principal-human"
$env:TORSOR_RUNTIME_PRINCIPAL_ID = "principal-runtime"
$env:TORSOR_PROJECT_IDS = "project-sample"
npm run build --workspace @torsor/server
npm run start --workspace @torsor/server
```

The production provider is the GitHub Copilot CLI ACP adapter. It launches the
`copilot` command in the current directory by default. Set
`TORSOR_COPILOT_COMMAND` to use another executable location and
`TORSOR_PROVIDER_CWD` to set the provider working directory. The adapter keeps
its deny-by-default tool and environment policy.

`TORSOR_HOST` defaults to `127.0.0.1`, `TORSOR_PORT` defaults to `4317`, and
`TORSOR_RUNTIME_POLL_INTERVAL_MS` defaults to `250`. `TORSOR_PROJECT_IDS` is a
comma-separated list of Projects whose existing Attentions the Runtime scans
at startup; Projects encountered through durable outbox work are loaded
dynamically.

The bootstrap file uses `KernelBootstrap` JSON. It is applied idempotently when
the current-schema database opens. Incompatible development schemas fail
clearly and must be recreated; the host does not migrate them.

Library callers can use `createLocalRuntimeHost` with any existing
`ProviderAdapter`. Tests use the deterministic fake through this same
production composition path. `createTorsorHttpService` remains available for
HTTP-only embedding; when passed a shared Kernel, the caller retains Kernel
shutdown ownership.

Clients authenticate with `Authorization: Bearer <local-secret>`. Browsers can
exchange that credential at `POST /api/v1/session` for an HttpOnly,
SameSite-strict cookie that native `EventSource` sends automatically. The
session response also returns a CSRF token; cookie-authenticated command
requests must send it in `X-Torsor-CSRF` with `Content-Type: application/json`.
Session exchange reuses a live session only when the request supplies a valid
cookie whose principal context matches the bearer credential. Independent
cookie jars receive distinct session and CSRF identities, so logout or SSE
revocation in one browser session does not revoke another.

## HTTP contract

- `POST /api/v1/commands/{start-thread|reply-to-thread|send-to-run|cancel-run|withdraw-run-input}`
- `GET /api/v1/projects/:projectId/bootstrap`
- `GET /api/v1/projects/:projectId/channels`
- `GET /api/v1/channels/:channelId/threads?projectId=...&after=...&snapshot=...&limit=...`
- `GET /api/v1/threads/:threadRootId`
- `GET /api/v1/projects/:projectId/runs?after=...&snapshot=...&limit=...`
- `GET /api/v1/runs/:runId`
- `GET /api/v1/runs/:runId/activity?afterSequence=...&limit=...`
- `GET /api/v1/projects/:projectId/agents`
- `GET /api/v1/projects/:projectId/attentions`
- `GET /api/v1/events?projectId=...&cursor=...&batchSize=...`

Command bodies contain Kernel command fields except `type`, which the route
owns. Principal and author provenance are never accepted from the request
body. The authenticated local credential supplies the complete
`PrincipalContext`.

The SSE stream emits `event: torsor`, uses the durable Kernel `eventId` as the
SSE `id`, accepts either `Last-Event-ID` or `cursor`, and sends heartbeat
comments while idle. On automatic browser reconnect, `Last-Event-ID` takes
precedence over the original URL cursor. Clients bootstrap first, then
subscribe from `bootstrap.latestEventId` to avoid a snapshot/subscription gap.
Replay uses the Kernel `ReadPublicEvents` query, so authorization and filtered
cursor advancement remain project-scoped and bounded without rebuilding Thread
projections for every event.

Thread and Run list routes use the Kernel's atomic as-of projection pages.
`snapshot` from the first page is reused with `after` on later pages, excluding
concurrent creates and reconstructing mutable state at the advertised snapshot.
Agent status is returned from the authoritative Kernel status projection,
including Attention-only Activations and current Run work.
