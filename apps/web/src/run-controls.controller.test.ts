import { afterEach, describe, expect, it } from "vitest";
import { actions, controlHarness, controlsStorageKey, humanProjection, json, rejected } from "./test/run-controls";

const harnesses: ReturnType<typeof controlHarness>[] = [];
afterEach(() => harnesses.splice(0).forEach(({ controller }) => controller.dispose()));
async function setup(storage?: Map<string, string>) {
  const harness = controlHarness(storage);
  harnesses.push(harness);
  await harness.connect();
  return harness;
}

describe.each(actions)("Human $name controller (MVP 44.2.1)", (action) => {
  it("commits with observed revisions and session/CSRF, then refreshes durable facts without invented activity", async () => {
    const { controller, requests } = await setup();
    expect(await action.invoke(controller)).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.path).toBe(`/api/v1/commands/${action.slug}`);
    expect(requests[0]!.body).toMatchObject({ expectedRunRevision: 2, idempotencyKey: expect.any(String) });
    if (action.name === "withdraw") expect(requests[0]!.body).toMatchObject({ runInputId: "run-input-1", expectedDispositionRevision: 1 });
    expect(requests[0]!.init.credentials).toBe("include");
    expect(new Headers(requests[0]!.init.headers).get("X-Torsor-CSRF")).toBe("csrf-synthetic");
    expect(controller.getSnapshot().run?.run.revision).toBe(3);
    expect(controller.getSnapshot().thread?.runs[0]?.revision).toBe(3);
    expect(controller.getSnapshot().run?.activity).toEqual(humanProjection.activity);
    expect(controller.getSnapshot().run?.inputs[0]?.disposition).toBe(action.name === "withdraw" ? "Withdrawn" : "Abandoned");
    expect(await action.invoke(controller)).toBe(false);
    expect(requests).toHaveLength(1);
  });

  it("coalesces double activation, freezes the request after loss, and replays after reload even when settled", async () => {
    const harness = await setup();
    let release!: () => void;
    harness.setCommand(() => new Promise((_resolve, reject) => {
      release = () => reject(new TypeError("Synthetic response loss"));
    }));
    const pending = action.invoke(harness.controller);
    expect(await action.invoke(harness.controller)).toBe(false);
    expect(harness.requests).toHaveLength(1);
    const original = harness.requests[0]!.body;
    const persisted = harness.storage.get(controlsStorageKey)!;
    expect(persisted).toContain(String(original.idempotencyKey));
    expect(persisted).not.toMatch(/csrf|synthetic-human|Synthetic response|Inspect the synthetic/);
    release();
    expect(await pending).toBe(false);
    harness.controller.dispose();
    const reopened = await setup(harness.storage);
    reopened.setProjection({
      ...humanProjection,
      run: { ...humanProjection.run, revision: 9, state: "Cancelled" },
      inputs: [{ ...humanProjection.inputs[0]!, disposition: "Withdrawn" }],
    });
    await reopened.controller.loadRun("run-1");
    expect(reopened.requests).toHaveLength(0);
    expect(await action.invoke(reopened.controller)).toBe(true);
    expect(reopened.requests[0]!.body).toEqual(original);
  });

  it.each(["stale_revision", "conflict"])("requires read-only refresh after definite %s before a new identity", async (code) => {
    const harness = await setup();
    harness.setCommand(async () => rejected(code));
    expect(await action.invoke(harness.controller)).toBe(false);
    expect(await action.invoke(harness.controller)).toBe(false);
    expect(harness.requests).toHaveLength(1);
    harness.setProjection({ ...humanProjection, run: { ...humanProjection.run, revision: 3 } });
    await harness.controller.refreshRunControls("run-1");
    harness.setCommand(null);
    expect(await action.invoke(harness.controller)).toBe(true);
    expect(harness.requests[1]!.body.expectedRunRevision).toBe(3);
    expect(harness.requests[1]!.body.idempotencyKey).not.toBe(harness.requests[0]!.body.idempotencyKey);
  });

  it.each([["unauthorized", 401], ["invalid_csrf_token", 403], ["forbidden", 403]] as const)(
    "retains unknown identity through %s and original-Human reauthentication", async (code, status) => {
      const harness = await setup();
      harness.setCommand(async () => { throw new TypeError("Synthetic response loss"); });
      expect(await action.invoke(harness.controller)).toBe(false);
      harness.setCommand(async () => rejected(code, status));
      expect(await action.invoke(harness.controller)).toBe(false);
      const original = harness.requests[0]!.body;
      harness.setPrincipal("principal-other");
      await harness.connect();
      expect(await action.invoke(harness.controller)).toBe(false);
      expect(harness.requests).toHaveLength(2);
      harness.setPrincipal("principal-human");
      await harness.connect();
      harness.setCommand(null);
      expect(await action.invoke(harness.controller)).toBe(true);
      expect(harness.requests[2]!.body).toEqual(original);
    },
  );

  it("does not turn an invalid receipt into success or a replacement request", async () => {
    const harness = await setup();
    harness.setCommand(async () => json({ result: { commandType: "CancelRun", entityId: "wrong-run", revision: 99 } }));
    expect(await action.invoke(harness.controller)).toBe(false);
    harness.setCommand(null);
    expect(await action.invoke(harness.controller)).toBe(true);
    expect(harness.requests[1]!.body).toEqual(harness.requests[0]!.body);
  });

  it("fails closed on corrupt recovery storage", async () => {
    const harness = await setup(new Map([[controlsStorageKey, "{broken"]]));
    await expect(action.invoke(harness.controller)).rejects.toThrow(/recovery/i);
    expect(harness.requests).toHaveLength(0);
    expect(harness.storage.get(controlsStorageKey)).toBe("{broken");
  });

  it("does not send or claim to be submitting when recovery metadata cannot be saved", async () => {
    const harness = await setup();
    harness.failStorage();
    await expect(action.invoke(harness.controller)).rejects.toThrow(/recovery/i);
    expect(harness.requests).toHaveLength(0);
    expect(Object.values(harness.controller.runControls.getSnapshot()).some((entry) => entry.status === "submitting")).toBe(false);
  });
});

describe("Human control eligibility (MVP 44.2.1)", () => {
  it.each(["Completed", "Failed", "Cancelled"] as const)("does not cancel or withdraw from a %s Run", async (state) => {
    const harness = await setup();
    harness.setProjection({ ...humanProjection, run: { ...humanProjection.run, state } });
    await harness.controller.loadRun("run-1");
    for (const action of actions) expect(await action.invoke(harness.controller)).toBe(false);
    expect(harness.requests).toHaveLength(0);
  });

  it.each(["Incorporated", "Declined", "Superseded", "Withdrawn", "Abandoned"] as const)("does not withdraw %s input", async (disposition) => {
    const harness = await setup();
    harness.setProjection({ ...humanProjection, inputs: [{ ...humanProjection.inputs[0]!, disposition }] });
    await harness.controller.loadRun("run-1");
    expect(await harness.controller.withdrawRunInput("run-1", "run-input-1")).toBe(false);
    expect(harness.requests).toHaveLength(0);
  });

  it("refuses another assigner, missing input, and mismatched selection", async () => {
    const harness = await setup();
    harness.setProjection({ ...humanProjection, inputs: [{ ...humanProjection.inputs[0]!, assignedByPrincipalId: "principal-other" }] });
    await harness.controller.loadRun("run-1");
    expect(await harness.controller.withdrawRunInput("run-1", "run-input-1")).toBe(false);
    expect(await harness.controller.withdrawRunInput("run-1", "missing")).toBe(false);
    expect(await harness.controller.withdrawRunInput("run-1", "")).toBe(false);
    await expect(harness.controller.cancelRun("run-other")).rejects.toThrow(/selected Run/);
    expect(harness.requests).toHaveLength(0);
  });
});
