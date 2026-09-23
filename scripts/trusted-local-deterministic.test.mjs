import test from "node:test";
import { fileURLToPath } from "node:url";
import { runSmoke } from "./trusted-local-smoke-run.mjs";

test("fixed native ACP performs the disposable Worktree edit/test with redacted durable facts", { timeout: 150_000 }, async () => {
  await runSmoke(fileURLToPath(new URL("../packages/agent-runtime/test/fixtures/native-acp-provider.mjs", import.meta.url)));
});
