# `@torsor/server`

`@torsor/server` provides the production local host for Torsor. The host owns
one `@torsor/kernel` SQLite connection, exposes it through the local HTTP and
durable Server-Sent Events service, and runs `@torsor/agent-runtime` against
that same Kernel.

Startup binds the HTTP listener only after configuration and the database have
opened successfully. Shutdown stops accepting HTTP work, aborts active Runtime
executions immediately, waits for physical stop/settlement, then closes the Kernel. Startup, Runtime-loop, and
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
`TORSOR_PROVIDER_CWD` to set the restricted provider working directory. The default
`TORSOR_PROVIDER_POLICY=restricted` keeps deny-by-default tools and environment.
For explicit `trusted-local`, set `TORSOR_PROVIDER_PERMISSION_MODE` to
`provider-default` or `allow-all`, plus `TORSOR_REPOSITORY_PATH`,
`TORSOR_WORKTREE_ROOT`, and full-commit `TORSOR_BASE_REVISION`. Trusted-local
rejects `TORSOR_PROVIDER_CWD`; Runtime derives cwd from the Run's assigned physical
Worktree. See [paired local usage documentation](../../docs/trusted-local.md).
`TORSOR_PROVIDER_TIMEOUT_MS` defaults to 120000 for trusted-local and 25000 for
restricted, bounded from 1000 through 295000; authority windows add 5000ms.

`TORSOR_HOST` defaults to `127.0.0.1`, `TORSOR_PORT` defaults to `4317`, and
`TORSOR_RUNTIME_POLL_INTERVAL_MS` defaults to `250`. `TORSOR_PROJECT_IDS` is a
comma-separated list of Projects whose existing Attentions the Runtime scans
at startup; Projects encountered through durable outbox work are loaded
dynamically.

The bootstrap file uses `KernelBootstrap` JSON. It is applied with schema/config
creation in one transaction only for an empty version-0 database, never reapplied
on reopen. Existing schema 18 files undergo complete read-only schema-contract
validation before a writable connection is opened. Incompatible or partial
development schemas fail unchanged; the host does not repair or migrate them.

Library callers can use `createLocalRuntimeHost` with any existing
`ProviderAdapter`. Tests use the deterministic fake through this same
production composition path. `createTorsorHttpService` remains available for
HTTP-only embedding; when passed a shared Kernel, the caller retains Kernel
shutdown ownership.

An embedding Host may explicitly supply `worktreeExecutorFactory(kernel)` to
enable the controlled Worktree tracer or trusted-local provider execution. The Host recovers physical
execution intents before listening and stops or quarantines admitted work before
closing Kernel. Policy selection alone never grants Writer authority, and no
HTTP route exposes arbitrary command execution. See the agent-runtime implementation reference and
MVP §§22, 24, 38, and 43.1 for the private-root and process-handle limitations.

Report Artifacts are opt-in. Set `TORSOR_ARTIFACT_ROOT` to a private local
directory with an existing trusted parent, outside Provider/Worktree write
scope. Library callers supply `artifactStorage` to `createLocalRuntimeHost`
or to the owned Kernel options of `createTorsorHttpService`; shared-Kernel
embedding configures the adapter on that Kernel. The executable uses
`LocalArtifactStorage`, whose storage/crash boundary is documented in the
Kernel package and paired MVP sections 21/23. Never expose this directory as
a static web root. Integrated schema 18 retains causal limits, trusted
Artifact descriptors, physical Worktree execution/publication fences, and the
allowlisted Provider diagnostic boundary, and adds native ProviderAttempt/policy
execution receipts. Schema 17 lacks these native receipts. Schema 16 can
contain pre-redaction public Provider diagnostics; all earlier development
schemas are also rejected before DDL/bootstrap. Stop old processes and
explicitly recreate the disposable
database and a fresh managed root, without migration, version rewriting, or silent deletion.

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
- `GET /api/v1/runs/:runId/activity?afterSequence=...&beforeSequence=...&limit=...`
- `GET /api/v1/artifacts/:artifactId`
- `GET /api/v1/artifacts/:artifactId/content`
- `GET /api/v1/projects/:projectId/agents`
- `GET /api/v1/projects/:projectId/attentions`
- `GET /api/v1/events?projectId=...&cursor=...&batchSize=...`

Activity bounds are exclusive. `beforeSequence` alone retrieves the nearest
older page, still returned in ascending sequence order; its `nextCursor` is the
earliest returned sequence when more history exists. `afterSequence` reads
forward, optionally capped by `beforeSequence` for finite reconnect catch-up.
The Run projection contains only the latest 100 activity items. All activity
pages use the same authentication and Run visibility rules as that projection.

Command bodies contain Kernel command fields except `type`, which the route
owns. Principal and author provenance are never accepted from the request
body. The authenticated local credential supplies the complete
`PrincipalContext`.

Artifact routes recheck current Kernel visibility; content downloads also
recheck browser-session validity after storage I/O. Download responses are
uncached plain-text attachments with `nosniff` and a restrictive CSP. IDs and
digests are not bearer credentials, internal paths never enter the contract,
and there is no HTTP descriptor-upload/publish endpoint.

The SSE stream emits `event: torsor`, uses the durable Kernel `eventId` as the
SSE `id`, accepts either `Last-Event-ID` or `cursor`, and sends heartbeat
comments while idle. On automatic browser reconnect, `Last-Event-ID` takes
precedence over the original URL cursor. Clients bootstrap first, then
subscribe from `bootstrap.latestEventId` to avoid a snapshot/subscription gap.
Replay uses the Kernel `ReadPublicEvents` query, so authorization and filtered
cursor advancement remain project-scoped and bounded without rebuilding Thread
projections for every event.
An Agent sees Artifact metadata/events only for its current Run, including
historical projections; Attention scopes see none. Filtered tails emit
`event: checkpoint` with the opaque scan cursor as both `id` and `data.cursor`,
without hidden Artifact metadata. Clients retain that cursor for replacement
connections; native reconnects use `Last-Event-ID`. Descriptor/content reads
validate live scope first and return the same generic 404 for absent and
inaccessible IDs. Unauthenticated calls remain 401 and stale scope errors do
not depend on Artifact existence.

Thread and Run list routes use the Kernel's atomic as-of projection pages.
`snapshot` from the first page is reused with `after` on later pages, excluding
concurrent creates and reconstructing mutable state at the advertised snapshot.
Agent status is returned from the authoritative Kernel status projection,
including Attention-only Activations and current Run work.
