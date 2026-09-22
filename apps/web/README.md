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

## Run locally

Start `@torsor/server` on its default `http://127.0.0.1:4317`, then:

```powershell
npm run dev:web
```

Vite proxies `/api` to the local server. A production host should serve the
built files from `apps/web/dist` and reverse proxy `/api` to `@torsor/server`
on the same origin.

Optional build-time settings:

```text
VITE_TORSOR_API_BASE       Absolute API origin when same-origin routing is unavailable
VITE_TORSOR_PROJECT_ID     Initial project ID (defaults to project-sample)
```

The bearer credential is used only for `POST /api/v1/session` and is cleared
from the form before the request settles. The HttpOnly cookie is managed by the
browser. The returned CSRF token is retained only in window `sessionStorage`
and memory, then removed on expiry, revocation, or sign-out. Same-origin open
windows relay session rotations through `BroadcastChannel` so the shared cookie
and per-window CSRF state remain aligned without using persistent storage.
