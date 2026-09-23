import { expect, it } from "vitest";
import { runSystemScenario } from "../src/index.js";

it("SS-2.2/SS-3.8.4: acknowledging a Runtime failure never consumes a distinct Provider assertion", async () => {
  const assertion = new Error("Synthetic Provider assertion failed.");
  const containsAssertion = (error: unknown): boolean => error === assertion ||
    (error instanceof AggregateError && error.errors.some(containsAssertion));
  await expect(runSystemScenario(async (system) => {
    system.provider(async ({ cause, capabilities }) => {
      if (cause.type === "attention") await capabilities.createRunFromAttention();
      else throw assertion;
    });
    await system.startThread();
    await system.expectRuntimeFailure(system.drain(), (error) => {
      expect(error).toMatchObject({ outcome: "Failed", message: assertion.message });
    });
  })).rejects.toSatisfy(containsAssertion);
});
