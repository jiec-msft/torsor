import { agent, ndJsonStream, RequestError, type AgentContext } from "@agentclientprotocol/sdk";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { loadScenario, type MockAction, type Scenario } from "./schema.js";
import { assertFacts, deferred, record } from "./facts.js";

class MockReplyError extends RequestError {}

let stdoutBytes = 0;
function write(stream: NodeJS.WritableStream, chunk: string | Uint8Array): Promise<void> {
  if (stream === process.stdout) stdoutBytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
  return new Promise((resolve, reject) => {
    stream.write(chunk, (error?: Error | null) => { if (error) reject(error); else resolve(); });
  });
}

function hold(): Promise<never> {
  setInterval(() => {}, 60_000);
  return new Promise(() => {});
}

export async function serveMock(scenario: Scenario): Promise<void> {
  if (!scenario.mock) throw new Error("Mock handlers are required.");
  const app = agent();
  const failureAcknowledged = deferred<void>();
  let failed = false;
  const reportFailure = async (): Promise<never> => {
    if (!failed) {
      failed = true;
      process.exitCode = 2;
      if (!process.send) {
        await write(process.stderr, "Mock action or assertion failed.\n");
        process.exit(2);
      }
      const acknowledge = (message: unknown) => {
        if (record(message) && message.type === "mock-failure-ack") {
          process.off("message", acknowledge);
          failureAcknowledged.resolve();
        }
      };
      process.on("message", acknowledge);
      process.send({ type: "mock-failure" }, (error) => { if (error) process.exit(2); });
    }
    await failureAcknowledged.promise;
    process.exit(2);
  };
  const gates = new Map<string, ReturnType<typeof deferred<void>>>();
  const gate = (name: string) => {
    let value = gates.get(name);
    if (!value) { value = deferred<void>(); gates.set(name, value); }
    return value;
  };
  const execute = async (actions: readonly MockAction[], context: AgentContext) => {
    for (const action of actions) {
      switch (action.type) {
        case "reply":
          if (action.errorCode !== undefined) throw new MockReplyError(action.errorCode, "Synthetic provider error.");
          return action.result;
        case "notify": await context.notify(action.method, action.params); break;
        case "wait": await gate(action.gate).promise; break;
        case "release": gate(action.gate).resolve(); break;
        case "request": {
          const outcome = await context.request(action.method, action.params).then(
            (value) => ({ ok: true as const, value }),
            (error: unknown) => ({ ok: false as const, error }),
          );
          if (action.errorCode !== undefined) {
            if (outcome.ok || !(outcome.error instanceof RequestError) || outcome.error.code !== action.errorCode) {
              throw new Error("Mock client error assertion failed.");
            }
          } else {
            if (!outcome.ok) throw new Error("Mock client request failed.");
            assertFacts(outcome.value, action.expect);
          }
          break;
        }
        case "fault": {
          const fault = action.fault;
          switch (fault.kind) {
            case "malformed": await write(process.stdout, "{invalid-json}\n"); break;
            case "oversized": await write(process.stdout, "x".repeat(fault.bytes)); break;
            case "stderr": await write(process.stderr, "x".repeat(fault.bytes)); break;
            case "wire": await write(process.stdout, JSON.stringify(fault.message) + (fault.newline ? "\n" : "")); break;
            case "stdout-close":
              if (!process.send) throw new Error("Stream closure faults require a harness-owned mock.");
              process.send({ type: "stdout-close", bytes: stdoutBytes });
              return hold();
            case "stdin-close":
              if (!process.send) throw new Error("Stream closure faults require a harness-owned mock.");
              process.send({ type: "stdin-close" });
              return hold();
            case "exit": process.exit(fault.code);
            case "hang": return hold();
          }
          break;
        }
      }
    }
    return {};
  };
  const runActions = async (actions: readonly MockAction[], context: AgentContext, request = false) => {
    try { return await execute(actions, context); }
    catch (error) {
      if (request && error instanceof MockReplyError) throw error;
      return reportFailure();
    }
  };
  for (const handler of scenario.mock.handlers) {
    const parse = (value: unknown) => value;
    if (handler.kind === "request") {
      app.onRequest(handler.method, parse, (context) => runActions(handler.actions, context.client, true));
    } else {
      app.onNotification(handler.method, parse, async (context) => { await runActions(handler.actions, context.client); });
    }
  }
  const eofActions = scenario.mock.onStdinClose;
  const connection = app.connect(ndJsonStream(
    new WritableStream<Uint8Array>({ write: (chunk) => write(process.stdout, chunk) }),
    new ReadableStream<Uint8Array>({
      start: (controller) => {
        process.stdin.on("data", (chunk: Buffer) => controller.enqueue(chunk));
        process.stdin.on("end", () => {
          void runActions(eofActions, connection.client).then(() => controller.close());
        });
      },
    }),
  ));
  await connection.closed;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const path = process.argv[2];
  if (!path) throw new Error("Mock scenario argument is required.");
  await serveMock(loadScenario(await readFile(path, "utf8"), { format: "json" }));
}
