# Contributing to Torsor

> English | [简体中文](CONTRIBUTING.zh-cn.md)

Torsor is in an early design and implementation stage. The contribution workflow will evolve with the first working slice.

## Public-source requirement

Contributions must be original work or derived only from sources that are publicly available and legally compatible with Apache-2.0.

Do not include:

- confidential or proprietary source material;
- links or references to private repositories and issue trackers;
- private logs, prompts, screenshots, workflows, or design files;
- customer, employee, or other personal data;
- credentials, tokens, cookies, or machine-specific paths.

Use synthetic data in examples, fixtures, screenshots, and tests.

## Changes

- Keep each change focused on one outcome.
- Explain what changed and why.
- Include tests for new or changed behavior.
- Keep commits and pull request descriptions free of non-public context.

## Specification-driven changes

- Locate and read the applicable specification before changing behavior.
- If the specification is missing, ambiguous, or conflicts with the requested behavior, clarify or update it before implementation rather than guessing.
- Behavior changes must update the Simplified Chinese and English specification counterparts in the same pull request.
- Code and tests must trace to explicit specification statements.

## Repository language

- Pull request titles use short, clear English in the repository's conventional format, such as `docs(spec): adopt bilingual workflow`.
- Pull request descriptions use concise Simplified Chinese by default. Keep code identifiers, commands, schemas, and literal UI strings in English syntax. Add an English counterpart when external collaborators need it.
- Source code, identifiers, code comments, commit messages, issue comments, and review comments remain English unless the content is explicitly localized.
- Follow the bilingual naming and synchronization rules in [Documentation language and pairing policy](docs/documentation.md).

For security vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of publishing details.
