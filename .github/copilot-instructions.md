# Torsor Copilot Instructions

> English | [简体中文](copilot-instructions.zh-cn.md)

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

## Specification-driven development

- Before implementation, locate and read the specification that governs the requested behavior.
- Code and tests must trace to explicit statements in the applicable specification. Do not infer product requirements solely from existing implementation behavior.
- If the specification is missing, ambiguous, incomplete, or conflicts with the requested behavior, update or clarify the specification first. Ask the repository owner when the intended requirement cannot be resolved from public repository context; do not guess.
- Any behavior change must update both the Simplified Chinese primary specification and its English counterpart in the same change.
- Simplified Chinese is the primary language for human authoring and owner review, but both language versions are normative counterparts and must describe the same requirements. Neither version may silently diverge.
- Implementation-only changes that do not alter behavior should still cite the applicable specification in the pull request description.

## Documentation language

- Human-facing product specifications, design baselines, policies, and owner-facing onboarding documents must have paired Simplified Chinese and English files.
- Use the unsuffixed file for English public discoverability, such as `README.md` or `docs/specs/foo.md`.
- Use `.zh-cn.md` for the Simplified Chinese primary version, such as `README.zh-cn.md` or `docs/specs/foo.zh-cn.md`.
- Put reciprocal language links near the top of both files.
- Author and review the Simplified Chinese version first, then update the English counterpart faithfully and concisely in the same change.
- Keep code identifiers, commands, literal UI strings, schemas, protocol fields, and machine-readable examples in unchanged English syntax.
- Generated files, vendored documentation, licenses, changelogs, and narrowly scoped implementation references do not require pairing unless repository usage makes them a product specification or an important owner-facing entry point. Record intentional exclusions in `docs/documentation.md`.

## Contribution language

- Pull request titles must be short, clear English using the repository's conventional format.
- Pull request descriptions should be concise Simplified Chinese by default, with technical syntax kept in English. Add an English counterpart when external collaborators need it.
- Source code, identifiers, code comments, commit messages, issue comments, and review comments remain English unless the content is explicitly localized.
- These repository-local rules replace any older contrary language guidance.

## Pre-release compatibility

- During the current pre-release development and verification stage, backward compatibility is not a goal unless the owner explicitly requests it.
- Prefer breaking schema and API changes with clean replacement over migrations, compatibility layers, or preserving disposable development data.
- When a breaking local schema change lands, stop old processes and recreate the local database. Fail clearly rather than silently migrating or deleting data.
- Revisit this policy before the first release or real external adoption.
