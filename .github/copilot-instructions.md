# Torsor Copilot Instructions

Torsor is a greenfield, public open-source project for durable human and agent collaboration.

## Product direction

- One person can coordinate multiple software agents.
- Work state must outlive any individual agent session.
- A message is communication, not automatically a task, decision, approval, or accepted result.
- A task describes durable work. A run is one bounded attempt to perform it.
- Uncertain external effects must remain explicit until reconciled.

## Engineering rules

- Keep this repository independently understandable and buildable.
- Use original work, public documentation, and public dependencies only.
- Do not copy or reference code, logs, screenshots, prompts, issue content, or design material from non-public sources.
- Use synthetic names and data in examples, fixtures, screenshots, and tests.
- Never commit credentials, tokens, customer data, or machine-specific paths.
- Prefer a small end-to-end slice over disconnected framework scaffolding.
- Preserve clear boundaries between collaboration state, execution state, local workspace state, and external systems.
- Add tests when behavior is introduced or changed.
- Keep dependencies minimal and verify that their licenses are compatible with Apache-2.0.

## Pre-release compatibility

- During the current pre-release development and verification stage, backward compatibility is not a goal unless the owner explicitly requests it.
- Prefer breaking schema and API changes with clean replacement over migrations, compatibility layers, or preserving disposable development data.
- When a breaking local schema change lands, stop old processes and recreate the local database. Fail clearly rather than silently migrating or deleting data.
- Revisit this policy before the first release or real external adoption.
