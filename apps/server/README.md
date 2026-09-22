# `@torsor/server`

`@torsor/server` exposes the public `@torsor/kernel` boundary through a local
HTTP API and durable Server-Sent Events stream. It opens one SQLite database
for the process lifetime and closes it on `SIGINT` or `SIGTERM`.

Build the workspace, then start the service with a local Human principal:

```powershell
$env:TORSOR_DATABASE_PATH = ".torsor\torsor.sqlite"
$env:TORSOR_BOOTSTRAP_PATH = ".torsor\bootstrap.json"
$env:TORSOR_AUTH_TOKEN = "replace-with-a-local-secret"
$env:TORSOR_PRINCIPAL_ID = "principal-human"
npm run build --workspace @torsor/server
npm run start --workspace @torsor/server
```

The bootstrap file uses `KernelBootstrap` JSON. It is applied idempotently when
the current-schema database opens. Incompatible development schemas fail
clearly and must be recreated; the server does not migrate them.

Clients authenticate with `Authorization: Bearer <local-secret>`. Browsers can
exchange that credential at `POST /api/v1/session` for an HttpOnly,
SameSite-strict cookie that native `EventSource` sends automatically. The
session response also returns a CSRF token; cookie-authenticated command
requests must send it in `X-Torsor-CSRF` with `Content-Type: application/json`.
Repeated exchanges for the same principal reuse its live browser session so
opening another same-origin window does not rotate the shared cookie away from
the CSRF token held by existing windows.

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
