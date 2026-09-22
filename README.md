# Torsor

> English | [简体中文](README.zh-cn.md)

Torsor is an open-source environment for durable collaboration between people and software agents.

Agents may stop, restart, or move between hosts. The work should continue from durable state.

> Agents change. Work persists.

## Why Torsor?

In mathematics, a torsor is like a space with no distinguished origin: relationships remain meaningful even when no single point is permanently central.

Torsor applies that idea to agent work. No agent session should become the irreplaceable owner of a goal, decision, or next action.

## Status

Torsor is at an early design and implementation stage. The first working slice will focus on one person coordinating replaceable agent sessions through durable work state.

## Quick start

### Prerequisites

- Git
- Node.js **22.13 or later**
- The npm version bundled with Node.js

Run all commands below from the repository root. They are verified in Windows
PowerShell; the Node commands also work directly in POSIX shells.

```powershell
npm ci
```

Run the focused credential-free quick-start test or the complete repository
validation:

```powershell
npm run test:quickstart
npm run ci
```

### Start the synthetic MVP

In the first terminal:

```powershell
npm run quickstart:host
```

This builds the Server and its dependencies, then starts a loopback-only Host
at `http://127.0.0.1:4317`. It uses the
[complete synthetic bootstrap](examples/working-quickstart/bootstrap.json),
the production `createLocalRuntimeHost` composition path, and the fixed
`DeterministicFakeAdapter`. It needs no model, model credential, or network
access and does not change the production CLI's provider defaults. State is
stored under `.torsor/quickstart`.

In a second terminal, run the checked minimum HTTP journey:

```powershell
npm run quickstart:http
```

The script checks `/health`, exchanges the local bearer
`torsor-local-demo` for an HttpOnly session cookie and CSRF token, reads
bootstrap, starts a Thread targeting `agent-orbit`, waits for its Run to
complete, and reads the Run and activity projections. Dynamic IDs come from
the real responses and are written to `.torsor/quickstart/last-run.json`.

Press `Ctrl+C` in the first terminal, run `npm run quickstart:host` again, then
verify that same durable Run:

```powershell
npm run quickstart:http -- --verify
```

### Web development and local static preview

Keep the synthetic Host running. The development server proxies `/api` and
`/health` to the local Host:

```powershell
npm run dev:web
```

Open the URL printed by Vite and use the local token `torsor-local-demo`. To
exercise the built static files, use the same loopback-only smoke proxy:

```powershell
npm run build --workspace @torsor/web
npm run preview:web
```

`preview:web` is not a production deployment or production reverse proxy. The
repository does not currently provide a production Web server; a deployment
must serve `apps/web/dist` and proxy `/api` to the Torsor Host on the same
origin.

### Deterministic ACP mock

This starts the independent ACP v1 mock without a model, credentials, or
network access. Stop it with `Ctrl+C`:

```powershell
npm run build --workspace @torsor/acp-conformance
npm exec -- acp-conformance mock packages\acp-conformance\examples\basic.json
```

See the [ACP conformance quick start](packages/acp-conformance/README.md) for
the full scenario set and explicit real-provider opt-in rules.

## Documentation

- [Independent ACP provider conformance harness](packages/acp-conformance/README.md) ([简体中文](packages/acp-conformance/README.zh-cn.md))

- [Product definition](docs/product.md) ([简体中文](docs/product.zh-cn.md))
- [MVP 0.1 core and interactive prototype](docs/prototype/001-overview.md) ([简体中文](docs/prototype/001-overview.zh-cn.md))
- [Documentation language and pairing policy](docs/documentation.md) ([简体中文](docs/documentation.zh-cn.md))
- [Public content policy](docs/public-content.md) ([简体中文](docs/public-content.zh-cn.md))
- [Contributing](CONTRIBUTING.md) ([简体中文](CONTRIBUTING.zh-cn.md))
- [Security policy](SECURITY.md) ([简体中文](SECURITY.zh-cn.md))

## License

Torsor is licensed under the Apache License 2.0.
