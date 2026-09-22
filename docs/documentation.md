# Documentation Language and Pairing Policy

> English | [简体中文](documentation.zh-cn.md)

Simplified Chinese is the primary language for human authoring and owner review. Unsuffixed English files remain the public-discovery counterparts. Both versions are normative and must describe the same requirements.

## Naming and synchronization

- English uses the unsuffixed path: `README.md`, `docs/product.md`, or `docs/specs/foo.md`.
- Simplified Chinese uses `.zh-cn.md`: `README.zh-cn.md`, `docs/product.zh-cn.md`, or `docs/specs/foo.zh-cn.md`.
- Both files link to each other near the top.
- A behavior change updates both counterparts in the same pull request.
- Code identifiers, commands, literal UI strings, schemas, protocol fields, and machine-readable examples retain their English syntax.
- If a requirement is missing, ambiguous, or conflicting, clarify the specification before implementation rather than guessing.

## Tracked documentation audit

This audit covers every tracked Markdown file in the repository at the time this policy was adopted.

At adoption, `docs/prototype/001-overview.zh-cn.md` was the only locale-suffixed document and had no English counterpart. The root `README.md` linked to it as the MVP 0.1 core baseline. The English-only Copilot instructions, top-level onboarding and policy files, product/public-content documents, and both prototype entry points therefore needed Simplified Chinese counterparts. The four component/package READMEs below were reviewed and intentionally excluded for the stated reasons.

| English path | Simplified Chinese path | Classification | Pairing decision |
|---|---|---|---|
| `.github/copilot-instructions.md` | `.github/copilot-instructions.zh-cn.md` | Agent and repository policy | Paired; normative workflow |
| `README.md` | `README.zh-cn.md` | Top-level onboarding | Paired |
| `CONTRIBUTING.md` | `CONTRIBUTING.zh-cn.md` | Contribution policy | Paired |
| `SECURITY.md` | `SECURITY.zh-cn.md` | Public security policy | Paired |
| `docs/product.md` | `docs/product.zh-cn.md` | Product specification | Paired; normative |
| `docs/public-content.md` | `docs/public-content.zh-cn.md` | Public-content policy | Paired; normative |
| `docs/prototype/001-overview.md` | `docs/prototype/001-overview.zh-cn.md` | MVP 0.1 design baseline | Paired; Simplified Chinese is primary |
| `docs/prototype/mvp-0.1/README.md` | `docs/prototype/mvp-0.1/README.zh-cn.md` | Prototype usage and evidence index | Paired; owner-facing design entry point |
| `prototype/README.md` | `prototype/README.zh-cn.md` | Earlier prototype onboarding | Paired; owner-facing entry point |
| `docs/documentation.md` | `docs/documentation.zh-cn.md` | Documentation policy and audit | Paired; normative |
| `apps/server/README.md` | Not required | Component implementation reference | English-only; route and authentication reference tied directly to English API syntax, not a product specification or owner onboarding entry point |
| `apps/web/README.md` | Not required | Component implementation reference | English-only; build and client-state reference tied directly to implementation |
| `packages/agent-runtime/README.md` | Not required | Package implementation reference | English-only; detailed runtime contract maintained with code rather than used as the human product baseline |
| `docs/specs/acp-conformance.md` | `docs/specs/acp-conformance.zh-cn.md` | Independent ACP harness specification and public reuse research | Paired; normative |
| `packages/acp-conformance/README.md` | `packages/acp-conformance/README.zh-cn.md` | Independent tool onboarding | Paired; owner-facing and external provider-author entry point |
| `packages/kernel/README.md` | Not required | Package implementation reference | English-only; detailed API and schema reference maintained with code rather than used as the human product baseline |

Generated assets, source files under documentation prototype directories, screenshots, the license text, and nonexistent changelog/vendor artifacts are not product specifications and are outside Markdown pairing scope.

Revisit an exclusion when a file becomes normative, appears in top-level owner navigation, or becomes the primary entry point for a product area.
