# Local Copilot Execution

> English | [简体中文](trusted-local.zh-cn.md)

## Prerequisites and trust boundary

Use Node.js 22.13+, Git, and an installed Copilot CLI authenticated separately
(or configured with BYOK), then `npm ci` and `npm run build`. Windows requires
Windows PowerShell/.NET and Job Objects; Linux requires readable `/proc`.
Other platforms currently reject native launch. On Windows,
`TORSOR_COPILOT_COMMAND` should name a native executable, not a `.cmd`/`.ps1` shim.
Installation/build do not start a real model. Trust the repository, user
configuration, custom instructions, and MCP servers.

`restricted` is the default deterministic deny-by-default tool profile.
`trusted-local` is explicit and enables normal provider shell, file, URL,
custom instructions, configured MCP, and user environment. It is not a hostile-code
sandbox: the provider has the user's local privileges; cwd and leases are not
access isolation. Do not use it on an untrusted shared Host. External API/MCP
effects have no exactly-once guarantee.

`TORSOR_*`, `COPILOT_ALLOW_ALL`, and `COPILOT_ASSISTED_APPROVAL` are filtered from
the provider environment. Authentication stays provider-owned; never put credentials
in prompts, bootstrap, Threads, reports, or logs. Attention decisions remain
restricted; only Runs with assigned Worktrees may execute native tools.

## Host configuration

First configure bootstrap, database, HTTP authentication, Human Principal,
Runtime Principal, and Project IDs using the [Server reference](../apps/server/README.md).
Additional settings:

| Variable | Requirement |
|---|---|
| `TORSOR_PROVIDER_POLICY` | Defaults to `restricted`; explicitly select `trusted-local` |
| `TORSOR_PROVIDER_PERMISSION_MODE` | Required `provider-default` or `allow-all` for trusted-local; forbidden for restricted |
| `TORSOR_REPOSITORY_PATH` | Trusted local Git repository |
| `TORSOR_WORKTREE_ROOT` | Private dedicated root, not shared with repository content or another database |
| `TORSOR_BASE_REVISION` | Full immutable commit ID, not `main` |
| `TORSOR_COPILOT_COMMAND` | Optional provider executable; defaults to `copilot` |
| `TORSOR_PROVIDER_TIMEOUT_MS` | 1000–295000; defaults to 120000 trusted-local or 25000 restricted |

Trusted-local rejects `TORSOR_PROVIDER_CWD`. Runtime derives the Run assignment and
creates a detached Worktree at the pinned commit; unregistered leftovers are not
adopted. The database owns its managed root. `provider-default` does not approve
unattended permission requests. Unattended native work requires explicit `allow-all`;
that does not grant Kernel authority or bypass stop/publication fences.

Run `npm run start --workspace @torsor/server`. Before the first provider write,
acquire the Writer Lease and receipt binding Activation, Run, ProviderAttempt,
generation, fencing, and original process tree. Cancellation, expiry, and shutdown
stop physically before persisting evidence. Unknown stop quarantines the directory
and blocks replacement. Restart does not clear quarantine after losing the original
handle. Schema 18 rejects older development databases: stop old processes and
explicitly use a new database and root; no migration or automatic deletion.

Timeline retains only normalized Tool started/completed/failed facts and provenance,
not raw tool IDs, arguments, results, command paths, stdout/stderr, or ACP session IDs.
Final replies/reports are explicit public actions: never put private material in
them. Failures use fixed public diagnostics.

## Smoke and repeatable verification

`npm run test:trusted-local-smoke` uses a fixed synthetic ACP provider to edit/test
a disposable Worktree and assert public facts, plus real-provider opt-in gate tests.
Ordinary `npm run ci` includes it without real Copilot, real credentials, or model
network access.

After understanding local tool privileges, explicitly opt into real validation:

```text
npm run smoke:copilot -- --allow-real-provider
```

Without that argument, refusal precedes environment access, Git, temporary storage,
and provider launch. This command may use network, provider credentials, custom
instructions, and MCP; it is never ordinary CI. It supplies only a synthetic
repository, asks for `native-result.txt` and `node --test synthetic.test.cjs`,
and independently asserts the file, test, Run state, and Tool facts. Each provider
attempt is bounded to 120 seconds. Confirmed stop removes Torsor temporary content
and database without printing provider text. Unconfirmed stop preserves quarantine
and fails, requiring local confirmation before cleanup rather than deleting a
possibly live Writer's directory. Provider-owned global sessions/logs and external
effects are outside this cleanup.

See the [specification](specs/trusted-local-provider-policy.md) and
[Runtime reference](../packages/agent-runtime/README.md). Cross-restart automatic
quarantine clearance, multiple Hosts, containers/VMs, arbitrary cwd, and a complete
permission UI are outside this slice.
