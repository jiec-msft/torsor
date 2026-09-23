import { vi } from "vitest";
import { WebController } from "../controller";
import { agent, bootstrap, runProjection, thread } from "./fixtures";
import type { RunProjection } from "../types";

export const controlsStorageKey = "torsor.run-controls.v1";
export const humanProjection: RunProjection = {
  ...runProjection,
  inputs: [{
    ...runProjection.inputs[0]!,
    assignedByPrincipalId: "principal-human",
    assignedByActivationId: null,
  }],
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  });
}

export function rejected(code: string, status = 409): Response {
  return json({ error: { code, message: `Synthetic ${code}`, requestId: "request-synthetic" } }, status);
}

export function controlHarness(storage = new Map<string, string>()) {
  const requests: Array<{ path: string; body: Record<string, unknown>; init: RequestInit }> = [];
  let projection = humanProjection;
  let principalId = "principal-human";
  let readFailure: "run" | "thread" | null = null;
  let storageFailure = false;
  let command: ((path: string, body: Record<string, unknown>) => Promise<Response>) | null = null;
  const controller = new WebController({
    sessionStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => {
        if (storageFailure && key === controlsStorageKey) throw new Error("Synthetic storage failure");
        storage.set(key, value);
      },
      removeItem: (key) => { storage.delete(key); },
    },
    eventSourceFactory: (url) => Object.assign(new EventTarget(), {
      url, close: vi.fn(), onopen: null, onerror: null,
    }) as unknown as EventSource,
    broadcastChannelFactory: (name) => Object.assign(new EventTarget(), {
      name, close: vi.fn(), postMessage: vi.fn(), onmessage: null, onmessageerror: null,
    }),
    fetch: async (input, init = {}) => {
      const path = String(input);
      if (path.endsWith("/session")) return json({ authenticated: true, principalId, csrfToken: "csrf-synthetic" });
      if (path.includes("/commands/")) {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        requests.push({ path, body, init });
        if (command) return command(path, body);
        const withdrawal = path.endsWith("/withdraw-run-input");
        projection = {
          ...projection,
          run: { ...projection.run, revision: projection.run.revision + 1, state: withdrawal ? "Active" : "Cancelled" },
          inputs: projection.inputs.map((value) => ({
            ...value, disposition: withdrawal ? "Withdrawn" : "Abandoned",
            dispositionRevision: value.dispositionRevision + 1,
          })),
        };
        return json({ result: withdrawal ? {
          commandType: "WithdrawRunInput", entityId: body.runInputId,
          revision: Number(body.expectedDispositionRevision) + 1,
          relatedIds: { runId: "run-1", runRevision: String(Number(body.expectedRunRevision) + 1) },
        } : {
          commandType: "CancelRun", entityId: body.runId, revision: Number(body.expectedRunRevision) + 1,
        } });
      }
      if (path.includes("/bootstrap")) return json({ bootstrap });
      if (path.includes("/agents")) return json({ items: [agent] });
      if (path.includes("/attentions")) return json({ items: [], hasMore: false });
      if (path.includes("/projects/") && path.includes("/runs")) return json({ items: [projection], hasMore: false });
      if (path.includes("/runs/")) return readFailure === "run" ? rejected("projection_unavailable", 503) : json({ run: projection });
      const currentThread = { ...thread, runs: [projection.run] };
      if (path.includes("/channels/") && path.includes("/threads")) return json({ items: [currentThread], hasMore: false });
      if (path.includes("/threads/")) return readFailure === "thread" ? rejected("projection_unavailable", 503) : json({ thread: currentThread });
      throw new Error(`Unexpected request: ${path}`);
    },
  });
  return {
    controller, requests, storage,
    setProjection: (value: RunProjection) => { projection = value; },
    setPrincipal: (value: string) => { principalId = value; },
    failReads: (value: typeof readFailure) => { readFailure = value; },
    failStorage: () => { storageFailure = true; },
    setCommand: (value: typeof command) => { command = value; },
    async connect() {
      await controller.exchangeSession("synthetic-human", "project-sample");
      await controller.loadThread("thread-1");
      await controller.loadRun("run-1");
    },
  };
}

export const actions = [
  { name: "cancel", label: "Cancel Run", slug: "cancel-run", invoke: (controller: WebController) => controller.cancelRun("run-1") },
  { name: "withdraw", label: "Withdraw Input 1 (run-input-1)", slug: "withdraw-run-input", invoke: (controller: WebController) => controller.withdrawRunInput("run-1", "run-input-1") },
] as const;
