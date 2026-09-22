# Torsor chat prototype

> English | [简体中文](README.zh-cn.md)

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

## Current design baseline

This React application records an earlier executable exploration. The accepted
MVP 0.1 core, desktop interaction model, and dependency-free design prototype
are documented in the
[MVP 0.1 design baseline (English)](../docs/prototype/001-overview.md) and
[Simplified Chinese primary](../docs/prototype/001-overview.zh-cn.md).

The next implementation slice should use that baseline when replacing or
reusing behavior from this exploration.

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
