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
| `docs/specs/system-scenarios.md` | `docs/specs/system-scenarios.zh-cn.md` | System-test contract | Paired; normative |
| `packages/system-scenarios/README.md` | `packages/system-scenarios/README.zh-cn.md` | System-test onboarding | Paired; owner-facing |
| `packages/kernel/README.md` | Not required | Package implementation reference | English-only; detailed API and schema reference maintained with code rather than used as the human product baseline |

Generated assets, source files under documentation prototype directories, screenshots, the license text, and nonexistent changelog/vendor artifacts are not product specifications and are outside Markdown pairing scope.

Revisit an exclusion when a file becomes normative, appears in top-level owner navigation, or becomes the primary entry point for a product area.

## Executable pairing contract

`npm run check:docs` is the deterministic local and CI command, requiring only the repository's Node.js version and Git. `npm run test:docs` tests this section through the public CLI and temporary Git repositories; `npm run ci` includes both commands.

### Files and top navigation

- Check Markdown files tracked by the current Git index (recognizing all case variants of `.md`), reading working-tree content, but require lowercase `.md` in valid filenames. Run `git add` for new files first; untracked and ignored files are outside scope. Staged and unstaged edits and deletions are included.
- Except for the explicit paths below, every Markdown file requires a same-directory, case-exact English `.md` / Simplified Chinese `.zh-cn.md` counterpart. New documents require pairing by default; no directory or filename receives an implicit exemption.
- Pairing must be one-to-one and reversible: a counterpart's counterpart must be the original file. An English filename must have a nonempty stem before `.md` that does not end in any case variant of `.zh-cn`; Chinese adds exactly one lowercase `.zh-cn` suffix to that English name. Repeated or mixed-case locale suffixes, empty stems, and non-lowercase extensions fail with `document-name`, even if listed as exclusions. Only trailing filename suffixes count, not directory names or interior `.zh-cn` text. Invalid old names may be deleted or renamed without inventing counterparts for them; valid old and new names still follow pairing and diff rules.
- Files must be regular files, not symbolic links. The first nonblank line must be a `# ` level-one title; the next nonblank line must use the repository's one-line language navigation: `> English | [简体中文](name.zh-cn.md)` or `> [简体中文（主要版本）](name.zh-cn.md) | English` for English, and `> 简体中文（主要版本） | [English](name.md)` for Chinese.
- The destination must be the exact sibling filename, optionally prefixed by one literal `./`. Remaining raw characters are limited to ASCII letters, digits, `-._~`, and `%HH` escapes; all other literal characters, including Chinese filename characters, require UTF-8 percent-encoding. A raw `&` fails with `navigation-encoding` and must be written as `%26`; Markdown entities are not interpreted. Decode exactly once, require an exact counterpart filename match, and reject decoded `/`, backslashes, or control characters. Do not further normalize directories, dot segments, or repeated encoding. Literal `#` and `?` cannot introduce fragments or queries; filenames containing those characters require `%23` and `%3F` respectively.
- Documents may start with one BOM and use LF or CRLF. Links in body text, code blocks, comments, images, or other positions do not replace top navigation. External URLs, fragments, queries, and reference-style links are not accepted; this is not a general Markdown parser.

### Explicit exclusions

The JSON array between these markers is the current exclusion list. Its Chinese counterpart must list exactly the same paths, each with a nonempty reason in both versions. Only exact, normalized repository-relative English `.md` paths are allowed; globs, directories, and `.zh-cn.md` exclusions are not supported. Duplicate, invalid, deleted, or already-paired exclusions fail. Moving, deleting, or promoting an excluded file requires updating both policy lists. Nonexistent generated, vendor, license, or changelog documents receive no advance wildcard exemption.

<!-- bilingual-exclusions:start -->
```json
[
  {
    "path": "apps/server/README.md",
    "reason": "Component implementation reference: route and authentication syntax, not a product specification or owner onboarding entry point."
  },
  {
    "path": "apps/web/README.md",
    "reason": "Component implementation reference: build and client state, not the product baseline."
  },
  {
    "path": "packages/agent-runtime/README.md",
    "reason": "Package implementation reference: runtime contract maintained with code, not the human product baseline."
  },
  {
    "path": "packages/kernel/README.md",
    "reason": "Package implementation reference: API and schema maintained with code, not the human product baseline."
  }
]
```
<!-- bilingual-exclusions:end -->

### Pull request diff checks

`npm run check:docs -- --base <git-ref>` adds net-change checks from the unique merge base of `<git-ref>` and `HEAD` to the current working tree, alongside the full structural check. Committed, staged, and unstaged tracked changes are included; new files still need `git add`. CI fetches full history, checks out the event's immutable `pull_request.head.sha`, then invokes this mode with `pull_request.base.sha`, never running this diff check on GitHub's synthetic merge commit. A `push` / `main` event explicitly falls back to that event's `github.sha`, using the full structural check and ordinary `npm run ci` only; this workflow does not additionally validate the synthetic merged tree. Tests use a real forked history with independent bilingual edits and a synthetic merge fixture to demonstrate checked-out head and push fallback behavior. Invalid refs, missing history, multiple merge bases, or unresolved index conflicts fail explicitly rather than falling back to a non-diff check.

Any net change to a file requiring pairing in either the base or current state, including formatting-only changes, requires a net change to its counterpart path. Exemptions apply only where explicitly listed in the corresponding state's policy; a newly added exclusion cannot retroactively exempt a normative base document. For bases predating this contract with no list markers in either policy file, no base-side exemptions are assumed.

Renames are treated as deletions at old paths and additions at new paths, without similarity inference. Both old and new counterparts must therefore be handled: paired renames or deletions pass, while orphans and omitted counterpart changes fail. Changes fully reverted before comparison do not count. Formatting-only counterpart edits can satisfy the mechanical check but cannot replace faithful translation and human review.

### Output and limits

Exit codes are `0` for success, `1` for policy violations, and `2` for argument, Git, or read failures. Violations are sorted in fixed lexical order, each with a repository-relative `/` path and stable diagnostic code, without machine-absolute paths. `--help` prints usage.

The check establishes only the structural contract for files, navigation, exclusion lists, and changed paths. It cannot prove semantic equivalence, translation quality, Chinese-first authoring or review, justification of exclusions, or validity of all body links. Human review must still determine whether both versions describe the same requirements. This layer touches only documentation, scripts, and CI, can be reverted independently, and does not change product runtime behavior.
