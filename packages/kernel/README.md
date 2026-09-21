# `@torsor/kernel`

`@torsor/kernel` is the durable local state boundary for the first Torsor
implementation slice. It stores collaboration and execution facts in SQLite
while keeping SQL and provider details behind three consumer operations:

```ts
kernel.execute(command, principalContext);
kernel.query(query, principalContext);
kernel.readEvents(afterEventId, limit);
```

Open a file-backed production database or the same adapter in memory:

```ts
import { TorsorKernel } from "@torsor/kernel";

const kernel = TorsorKernel.open({
  databasePath: "./torsor.sqlite",
  bootstrap: {
    principals: [
      { id: "human-1", kind: "human", displayName: "Avery Stone" },
    ],
    projects: [{ id: "project-1", name: "Sample Project" }],
    channels: [
      { id: "channel-1", projectId: "project-1", name: "general" },
    ],
  },
});
```

Every command has a principal-scoped idempotency key. Runtime activity must
carry durable Activation or ProviderAttempt provenance. Provider session IDs
are diagnostic only; provider delivery never changes RunInput disposition or
other semantic state.
