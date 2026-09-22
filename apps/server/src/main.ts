import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { CopilotAcpAdapter } from "@torsor/agent-runtime";
import { LocalArtifactStorage, type KernelBootstrap, type PrincipalContext } from "@torsor/kernel";

import { createLocalRuntimeHost } from "./local-runtime-host.js";

async function main(): Promise<void> {
  const databasePath = resolve(
    process.env.TORSOR_DATABASE_PATH ?? ".torsor/torsor.sqlite",
  );
  const principalContext: PrincipalContext = {
    principalId: requiredEnvironment("TORSOR_PRINCIPAL_ID"),
    ...(process.env.TORSOR_ACTIVATION_ID
      ? { activationId: process.env.TORSOR_ACTIVATION_ID }
      : {}),
  };
  const bootstrap = process.env.TORSOR_BOOTSTRAP_PATH
    ? await loadBootstrap(resolve(process.env.TORSOR_BOOTSTRAP_PATH))
    : undefined;
  await mkdir(dirname(databasePath), { recursive: true });
  const artifactStorage = process.env.TORSOR_ARTIFACT_ROOT
    ? await LocalArtifactStorage.open(resolve(process.env.TORSOR_ARTIFACT_ROOT))
    : undefined;

  const host = createLocalRuntimeHost({
    databasePath,
    ...(artifactStorage ? { artifactStorage } : {}),
    credentials: [
      {
        token: requiredEnvironment("TORSOR_AUTH_TOKEN"),
        principalContext,
      },
    ],
    runtimePrincipalId: requiredEnvironment("TORSOR_RUNTIME_PRINCIPAL_ID"),
    projectIds: requiredListEnvironment("TORSOR_PROJECT_IDS"),
    adapter: new CopilotAcpAdapter({
      ...(process.env.TORSOR_COPILOT_COMMAND
        ? { command: process.env.TORSOR_COPILOT_COMMAND }
        : {}),
      ...(process.env.TORSOR_PROVIDER_CWD
        ? { cwd: resolve(process.env.TORSOR_PROVIDER_CWD) }
        : {}),
    }),
    ...(bootstrap ? { bootstrap } : {}),
    host: process.env.TORSOR_HOST ?? "127.0.0.1",
    port: optionalInteger(process.env.TORSOR_PORT, "TORSOR_PORT", 4317, 0),
    runtimePollIntervalMs: optionalInteger(
      process.env.TORSOR_RUNTIME_POLL_INTERVAL_MS,
      "TORSOR_RUNTIME_POLL_INTERVAL_MS",
      250,
      1,
    ),
  });

  const close = () => {
    void host.close().catch(() => undefined);
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  try {
    const origin = await host.start();
    process.stdout.write(`Torsor local runtime host listening at ${origin}\n`);
    await host.finished;
  } finally {
    process.removeListener("SIGINT", close);
    process.removeListener("SIGTERM", close);
  }
}

async function loadBootstrap(path: string): Promise<KernelBootstrap> {
  const content = await readFile(path, "utf8");
  const parsed: unknown = JSON.parse(content);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("TORSOR_BOOTSTRAP_PATH must contain a JSON object.");
  }
  return parsed as KernelBootstrap;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function requiredListEnvironment(name: string): readonly string[] {
  const values = requiredEnvironment(name)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length === 0) {
    throw new Error(`${name} must contain at least one value.`);
  }
  return [...new Set(values)];
}

function optionalInteger(
  value: string | undefined,
  name: string,
  fallback: number,
  minimum: number,
): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > 65_535) {
    throw new Error(
      `${name} must be an integer between ${minimum} and 65535.`,
    );
  }
  return parsed;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${formatError(error)}\n`);
  process.exitCode = 1;
});
