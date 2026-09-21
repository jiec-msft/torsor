import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { KernelBootstrap, PrincipalContext } from "@torsor/kernel";

import { createTorsorHttpService } from "./server.js";

async function main(): Promise<void> {
  const databasePath = resolve(
    process.env.TORSOR_DATABASE_PATH ?? ".torsor/torsor.sqlite",
  );
  const token = requiredEnvironment("TORSOR_AUTH_TOKEN");
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
  const service = createTorsorHttpService({
    databasePath,
    credentials: [{ token, principalContext }],
    ...(bootstrap ? { bootstrap } : {}),
    host: process.env.TORSOR_HOST ?? "127.0.0.1",
    port: optionalPort(process.env.TORSOR_PORT),
  });
  const origin = await service.listen();
  process.stdout.write(`Torsor HTTP service listening at ${origin}\n`);

  let closing = false;
  const close = () => {
    if (closing) {
      return;
    }
    closing = true;
    void service.close().then(
      () => process.exit(0),
      (error: unknown) => {
        process.stderr.write(`${formatError(error)}\n`);
        process.exit(1);
      },
    );
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
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
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function optionalPort(value: string | undefined): number {
  if (value === undefined) {
    return 4317;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("TORSOR_PORT must be an integer between 0 and 65535.");
  }
  return port;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${formatError(error)}\n`);
  process.exitCode = 1;
});
