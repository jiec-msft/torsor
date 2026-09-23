# `@torsor/web`

Production Human-facing React 19 client for the local `@torsor/server` HTTP and
SSE API.

The interface preserves Torsor's context projection:

```text
Rail | Channels and Threads | Conversation | Status or Run detail
```

Channel, Thread, Run-detail, and panel selection live in the browser URL. They
are not Kernel objects and are not synchronized across windows. Server facts
are refreshed from durable SSE events and broadcast as invalidations to other
windows without copying view state.

An original Human author can append an edited Message revision or confirm a
tombstone without erasing history or provenance. The conversation renders the
latest projection and exposes immutable revision history, including each
revision's Mention set. Agent-authored Messages and another Human's Messages
do not expose these controls. Human operators can also create the next Agent
JSON configuration revision and explicitly adopt the current newer revision
for a nonterminal Run; already running Activations remain pinned to their
recorded revision.

These commands use expected revisions and recover unknown outcomes by retrying
the exact request with its original idempotency key. Definite conflicts and
permission failures remain visible rather than being treated as success.
Agent configuration content is held only for the active request/retry and is
not persisted in browser recovery metadata.

Run detail's Live Agent Timeline retains loaded `RunActivityEvent` history,
loads older items in explicit 100-item pages, and fills reconnect gaps through
the authenticated activity API. It follows output only while at the bottom;
scrolling upward pauses following until `Back to latest`. RunInput, Provider
execution, and authoritative Run state remain distinct from streamed output.
Unknown activity kinds expose metadata only. See MVP sections
[35.3, 37, and 44](../../docs/prototype/001-overview.md#37-streaming-output).

## Run locally

From the repository root, start `@torsor/server` on its default
`http://127.0.0.1:4317` (the credential-free path is
`npm run quickstart:host`), then:

```powershell
npm run dev:web
```

Vite proxies `/api` and `/health` to the local server. A production host
should serve the built files from `apps/web/dist` and reverse proxy `/api` to
`@torsor/server` on the same origin, but this repository does not currently
provide that production Web server or reverse-proxy configuration.

For a concrete local static preview:

```powershell
npm run build --workspace @torsor/web
npm run preview:web
```

The preview server proxies `/api` and `/health` to
`http://127.0.0.1:4317`, matching development mode. This is a local static
preview, not a production reverse proxy or deployment recipe.

Optional build-time settings:

```text
VITE_TORSOR_API_BASE       API origin supplied by an externally configured browser-compatible deployment
VITE_TORSOR_PROJECT_ID     Initial project ID (defaults to project-sample)
```

The supported local paths leave `VITE_TORSOR_API_BASE` unset and use the Vite
proxy. The local Server does not add a general cross-origin deployment policy.

The bearer credential is used only for `POST /api/v1/session` and is cleared
from the form before the request settles. The HttpOnly cookie is managed by the
browser. The returned CSRF token is retained only in window `sessionStorage`
and memory, then removed on expiry, revocation, or sign-out. Same-origin open
windows relay session rotations through `BroadcastChannel` so the shared cookie
and per-window CSRF state remain aligned without using persistent storage.
