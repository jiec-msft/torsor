import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  defaultQuickstartStateDirectory,
  quickstartToken,
} from "./host.mjs";

const defaultResultPath = resolve(
  defaultQuickstartStateDirectory,
  "last-run.json",
);

export async function runQuickstartJourney(options = {}) {
  const origin = options.origin ?? "http://127.0.0.1:4317";
  const resultPath = resolve(options.resultPath ?? defaultResultPath);
  const startedAt = performance.now();
  const health = await requestJson(`${origin}/health`);
  assert(health.status === "ok", "/health did not report status=ok.");

  const sessionResponse = await fetch(`${origin}/api/v1/session`, {
    method: "POST",
    headers: { Authorization: `Bearer ${quickstartToken}` },
  });
  await assertStatus(sessionResponse, 201, "session exchange");
  const cookie = sessionResponse.headers.get("set-cookie")?.split(";", 1)[0];
  assert(cookie, "The session response did not set a cookie.");
  const session = await sessionResponse.json();
  assert(
    typeof session.csrfToken === "string" && session.csrfToken.length > 0,
    "The session response did not return a CSRF token.",
  );
  const sessionHeaders = { Cookie: cookie };

  const bootstrapBody = await requestJson(
    `${origin}/api/v1/projects/project-sample/bootstrap`,
    { headers: sessionHeaders },
  );
  assert(
    bootstrapBody.bootstrap?.project?.id === "project-sample",
    "The synthetic Project was not returned by bootstrap.",
  );
  assert(
    bootstrapBody.bootstrap.agents?.some(
      (agent) => agent.id === "agent-orbit",
    ),
    "The synthetic Agent was not returned by bootstrap.",
  );

  let identifiers;
  if (options.verifyOnly) {
    identifiers = JSON.parse(await readFile(resultPath, "utf8"));
  } else {
    const command = await requestJson(
      `${origin}/api/v1/commands/start-thread`,
      {
        method: "POST",
        headers: {
          ...sessionHeaders,
          "Content-Type": "application/json",
          "X-Torsor-CSRF": session.csrfToken,
        },
        body: JSON.stringify({
          idempotencyKey: `quickstart:${randomUUID()}`,
          projectId: "project-sample",
          channelId: "channel-general",
          body: "Orbit, complete this synthetic durable request.",
          targetAgentIds: ["agent-orbit"],
        }),
      },
    );
    assert(
      typeof command.result?.entityId === "string",
      "start-thread did not return a Thread ID.",
    );
    const thread = await waitForCompletedThread(
      origin,
      command.result.entityId,
      sessionHeaders,
    );
    const run = thread.runs.at(-1);
    assert(run, "The completed Thread did not contain a Run.");
    identifiers = {
      threadRootId: thread.threadRootId,
      runId: run.id,
    };
    await mkdir(dirname(resultPath), { recursive: true });
    await writeFile(
      resultPath,
      `${JSON.stringify(identifiers, null, 2)}\n`,
      "utf8",
    );
  }

  const threadBody = await requestJson(
    `${origin}/api/v1/threads/${encodeURIComponent(identifiers.threadRootId)}`,
    { headers: sessionHeaders },
  );
  const runBody = await requestJson(
    `${origin}/api/v1/runs/${encodeURIComponent(identifiers.runId)}`,
    { headers: sessionHeaders },
  );
  const activity = await requestJson(
    `${origin}/api/v1/runs/${encodeURIComponent(identifiers.runId)}/activity?limit=100`,
    { headers: sessionHeaders },
  );
  assert(
    threadBody.thread?.runs?.some(
      (run) => run.id === identifiers.runId && run.state === "Completed",
    ),
    "The completed Run was not present in the Thread projection.",
  );
  assert(
    runBody.run?.run?.state === "Completed",
    "The Run projection was not completed.",
  );
  assert(
    Array.isArray(activity.items) && activity.items.length > 0,
    "The completed Run did not expose activity.",
  );
  assert(
    activity.items.some((item) => item.kind === "provider_result"),
    "The deterministic provider activity was not projected.",
  );

  return {
    ...identifiers,
    activityCount: activity.items.length,
    elapsedMs: Math.round(performance.now() - startedAt),
    resultPath,
  };
}

async function waitForCompletedThread(origin, threadRootId, headers) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const body = await requestJson(
      `${origin}/api/v1/threads/${encodeURIComponent(threadRootId)}`,
      { headers },
    );
    const runs = body.thread?.runs ?? [];
    const failed = runs.find((run) =>
      ["Failed", "Cancelled"].includes(run.state),
    );
    assert(!failed, `Run ${failed?.id} ended as ${failed?.state}.`);
    if (runs.length > 0 && runs.every((run) => run.state === "Completed")) {
      return body.thread;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  throw new Error("The deterministic Run did not complete within 5 seconds.");
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  await assertStatus(response, 200, url);
  return response.json();
}

async function assertStatus(response, expected, operation) {
  if (response.status !== expected) {
    throw new Error(
      `${operation} returned HTTP ${response.status}: ${await response.text()}`,
    );
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function parseArguments(arguments_) {
  const options = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--help") {
      options.help = true;
      continue;
    }
    if (argument === "--verify") {
      options.verifyOnly = true;
      continue;
    }
    const value = arguments_[index + 1];
    if (!value) {
      throw new Error(`${argument} requires a value.`);
    }
    if (argument === "--origin") {
      options.origin = value;
    } else if (argument === "--result") {
      options.resultPath = resolve(value);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
    index += 1;
  }
  return options;
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

async function runCli() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      "Usage: node examples/working-quickstart/http-journey.mjs [--origin URL] [--result PATH] [--verify]\n",
    );
    return;
  }
  const result = await runQuickstartJourney(options);
  process.stdout.write(
    `${options.verifyOnly ? "Verified" : "Completed"} synthetic Run ${result.runId} with ${result.activityCount} activity items in ${result.elapsedMs} ms.\n`,
  );
  process.stdout.write(`Thread: ${result.threadRootId}\n`);
  process.stdout.write(`Result: ${result.resultPath}\n`);
}

const isMain =
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  void runCli().catch((error) => {
    process.stderr.write(`${formatError(error)}\n`);
    process.exitCode = 1;
  });
}
