import { once } from "node:events";
import { createServer } from "node:http";
import { expect, it } from "vitest";
import { runSystemScenario } from "../src/index.js";

it("SS-4.2: an unowned live handle fails instead of being hidden by runner exit", async () => {
  const unexpected = createServer();
  try {
    await expect(runSystemScenario(async () => {
      unexpected.listen(0, "127.0.0.1");
      await once(unexpected, "listening");
    })).rejects.toThrow("Scenario leaked handles");
  } finally {
    if (unexpected.listening) {
      await new Promise<void>((resolve, reject) => unexpected.close((error) => error ? reject(error) : resolve()));
    }
  }
});
