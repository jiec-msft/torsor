import { client, RequestError } from "@agentclientprotocol/sdk";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { assertFacts, assertJson, deferred, fail, HarnessError, record, resolveRefs, type Json } from "./facts.js";
import { deadline, OwnedProcess, within } from "./process.js";
import { resolveProvider, validateProvider, type Provider } from "./profiles.js";
import { validateScenario, type Scenario } from "./schema.js";
import { Transcript, type TranscriptEvent } from "./transcript.js";
import { Wire } from "./wire.js";

export interface RunOptions {
  provider?: Provider;
  allowReal?: boolean;
}

export interface RunResult {
  schemaVersion: 1;
  id: string;
  status: "passed" | "failed" | "skipped";
  diagnostics: { code: string; step: number; message: string }[];
  transcript: TranscriptEvent[];
}

type Response = { ok: true; value: unknown } | { ok: false; error: unknown };

export async function runScenario(input: Scenario, options: RunOptions = {}): Promise<RunResult> {
  const scenario = validateScenario(input);
  if (options.provider) validateProvider(options.provider);
  const transcript = new Transcript();
  const result: RunResult = {
    schemaVersion: 1, id: scenario.id, status: "passed", diagnostics: [], transcript: transcript.events,
  };
  if (options.provider && !options.allowReal) {
    result.status = "skipped";
    result.diagnostics.push({ code: "real_disabled", step: -1, message: "External provider execution requires explicit allowReal." });
    return result;
  }
  let workspace: string;
  try { workspace = await mkdtemp(join(tmpdir(), "acp-conformance-")); }
  catch {
    result.status = "failed";
    result.diagnostics.push({ code: "workspace_failed", step: -1, message: "Could not create the synthetic workspace." });
    return result;
  }
  let owned: OwnedProcess | undefined;
  let connection: ReturnType<ReturnType<typeof client>["connect"]> | undefined;
  let stepIndex = -1;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const diagnose = (error: unknown) => {
    const safe = error instanceof HarnessError ? error : new HarnessError("execution_failed", "Scenario execution failed.");
    result.status = "failed";
    result.diagnostics.push({ code: safe.code, step: stepIndex, message: safe.message });
  };
  try {
    const mockPath = join(workspace, "scenario.json");
    if (!options.provider) {
      if (!scenario.mock) fail("mock_missing", "The selected scenario has no mock handlers.");
      await writeFile(mockPath, JSON.stringify(scenario), { flag: "wx" });
    }
    owned = new OwnedProcess(options.provider ? resolveProvider(options.provider, workspace) : {
      command: process.execPath,
      args: [fileURLToPath(new URL("./mock.js", import.meta.url)), mockPath],
    }, workspace, scenario.limits, !options.provider);
    const processHandle = owned;
    timer = setTimeout(() => processHandle.fail("timeout", "Scenario exceeded its run deadline."), scenario.limits.runMs);
    const guard = <T>(promise: Promise<T>, budget = scenario.limits.stepMs) => deadline(
      Promise.race([promise, processHandle.failure.then((error) => { throw error; })]),
      budget,
    );
    transcript.add("harness", "started");
    const wire = new Wire(owned, scenario.limits, transcript, workspace);
    await guard(owned.started, scenario.limits.startupMs);
    const updates: Json[] = [];
    let updated = deferred<void>();
    connection = client()
      .onRequest("session/request_permission", () => ({ outcome: { outcome: "cancelled" } }))
      .onNotification("session/update", (value: unknown) => value, (context) => {
        assertJson(context.params);
        updates.push(context.params);
        updated.resolve();
        updated = deferred<void>();
      })
      .connect(wire.stream);
    const pending = new Map<string, Promise<Response>>();
    const responses = new Map<string, Json>();
    let inputClosed = false;
    let expectedExit: number | undefined;
    const closeInput = () => {
      if (inputClosed) return;
      inputClosed = true;
      processHandle.endInput();
      transcript.add("harness", "stdin-closed");
    };
    for (const [index, step] of scenario.steps.entries()) {
      stepIndex = index;
      if (owned.error) throw owned.error;
      if (step.type === "request") {
        if (pending.has(step.id) || responses.has(step.id)) fail("scenario_state", "Request labels must be unique.");
        const request = connection.agent.request(step.method, resolveRefs(step.params, workspace, responses));
        pending.set(step.id, request.then(
          (value): Response => ({ ok: true, value }),
          (error: unknown): Response => ({ ok: false, error }),
        ));
      } else if (step.type === "response") {
        const request = pending.get(step.id);
        if (!request) fail("scenario_state", "Response step must refer to an outstanding request.");
        const response = await guard(request);
        pending.delete(step.id);
        if (step.errorCode !== undefined) {
          if (response.ok || !(response.error instanceof RequestError) || response.error.code !== step.errorCode) {
            fail("assertion_failed", "Expected RPC error code was not observed.");
          }
        } else {
          if (!response.ok) fail("rpc_error", "Provider request failed; inspect the transcript error code.");
          assertJson(response.value);
          assertFacts(response.value, step.expect);
          responses.set(step.id, response.value);
        }
      } else if (step.type === "notification") {
        await guard(connection.agent.notify(step.method, resolveRefs(step.params, workspace, responses)));
      } else if (step.type === "update") {
        const consume = async () => {
          for (;;) {
            const found = updates.findIndex((value) => record(value) && record(value.update) && value.update.sessionUpdate === step.sessionUpdate);
            if (found >= 0) {
              assertFacts(updates.splice(found, 1)[0], step.expect);
              return;
            }
            await updated.promise;
          }
        };
        await guard(consume());
      } else if (step.type === "close-stdin") {
        closeInput();
      } else if (step.type === "exit") {
        expectedExit = step.code;
        if ((await guard(owned.exited)).code !== expectedExit) fail("process_exit", "Provider exited with an unexpected status.");
      }
    }
    if (pending.size > 0) fail("scenario_state", "Every started request must have a response step.");
    closeInput();
    const drained = await within(
      Promise.race([
        Promise.all([owned.exited, owned.stdoutEnded, owned.stderrEnded]),
        owned.failure.then((error) => { throw error; }),
      ]),
      scenario.limits.shutdownMs,
    );
    if (owned.error) throw owned.error;
    if (drained.done && expectedExit !== undefined && drained.value[0].code !== expectedExit) {
      fail("process_exit", "Provider exited with an unexpected status.");
    }
  } catch (error) {
    if (error instanceof HarnessError) owned?.fail(error.code, error.message);
    diagnose(owned?.error ?? error);
  }
  finally {
    clearTimeout(timer);
    try { await owned?.cleanup(scenario.limits.shutdownMs); }
    catch (error) { diagnose(error); }
    connection?.close();
    const lateError = owned?.error;
    if (lateError && !result.diagnostics.some((diagnostic) => diagnostic.code === lateError.code)) diagnose(lateError);
    try {
      await rm(workspace, {
        recursive: true, force: true, maxRetries: 3,
        retryDelay: Math.min(50, Math.floor(scenario.limits.shutdownMs / 6)),
      });
    } catch (error) {
      const code = record(error) && typeof error.code === "string" &&
        ["EBUSY", "ENOTEMPTY", "EPERM", "EACCES"].includes(error.code) ? ` (${error.code})` : "";
      diagnose(new HarnessError("cleanup_failed", `Could not remove the synthetic workspace${code}.`));
    }
    transcript.add("harness", "closed");
  }
  if (scenario.expectFailure) {
    if (result.diagnostics.length === 1 && result.diagnostics[0]?.code === scenario.expectFailure) result.status = "passed";
    else if (result.status === "passed") diagnose(new HarnessError("expected_failure_missing", "Expected failure was not observed."));
  }
  return result;
}

export async function runSuite(scenarios: readonly Scenario[], options: RunOptions = {}): Promise<RunResult[]> {
  const results: RunResult[] = [];
  for (const scenario of scenarios) results.push(await runScenario(scenario, options));
  return results;
}
