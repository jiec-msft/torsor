# Torsor chat prototype

This is a local discovery prototype for exploring how one deploying human can
coordinate multiple replaceable software agent sessions through durable work
state.

It is intentionally a small React application with deterministic in-memory
state. It is not the production architecture and does not include a backend,
authentication, persistence, or external integrations.

The prototype is designed to be explored. You can switch workstreams and agent
conversations, search local work, send deterministic messages and responses,
create tasks and workstreams, inspect artifacts and authority, retry runs,
review results, and reconcile uncertain external effects.

## Run locally

```sh
npm install
npm run dev
```

Open the local URL printed by Vite.

## Validate

```sh
npm test
npm run build
```

The tests exercise durable state transitions through the public workspace
interface, including edit invalidation before promotion, immutable promoted
message provenance, source-linked decisions and tasks, conversation-local
composer state, deterministic search destinations, atomic Agent lifecycle
changes, failed and retried runs, and human approval.
