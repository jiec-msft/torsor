import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { DeterministicFakeAdapter } from "@torsor/agent-runtime";
import { createLocalRuntimeHost } from "@torsor/server";

const exampleDirectory = dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = resolve(exampleDirectory, "..", "..");
export const defaultQuickstartStateDirectory = join(
  repositoryRoot,
  ".torsor",
  "quickstart",
);
export const quickstartToken = "torsor-local-demo";

export async function createQuickstartHost(options = {}) {
  const stateDirectory = resolve(
    options.stateDirectory ?? defaultQuickstartStateDirectory,
  );
  const bootstrap = JSON.parse(
    await readFile(join(exampleDirectory, "bootstrap.json"), "utf8"),
  );
  await mkdir(stateDirectory, { recursive: true });
  const host = createLocalRuntimeHost({
    databasePath: join(stateDirectory, "torsor.sqlite"),
    bootstrap,
    credentials: [
      {
        token: quickstartToken,
        principalContext: { principalId: "principal-human" },
      },
    ],
    runtimePrincipalId: "principal-runtime",
    projectIds: ["project-sample"],
    adapter: new DeterministicFakeAdapter(),
    host: options.host ?? "127.0.0.1",
    port: options.port ?? 4317,
    runtimePollIntervalMs: 10,
  });
  return { host, stateDirectory };
}

async function runCli() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      "Usage: node examples/working-quickstart/host.mjs [--state-dir PATH] [--host HOST] [--port PORT]\n",
    );
    return;
  }
  const { host, stateDirectory } = await createQuickstartHost(options);
  const close = () => {
    void host.close().catch((error) => {
      process.stderr.write(`${formatError(error)}\n`);
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  try {
    const origin = await host.start();
    process.stdout.write(`Torsor synthetic quickstart listening at ${origin}\n`);
    process.stdout.write(`State directory: ${stateDirectory}\n`);
    await host.finished;
  } finally {
    process.removeListener("SIGINT", close);
    process.removeListener("SIGTERM", close);
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
    const value = arguments_[index + 1];
    if (!value) {
      throw new Error(`${argument} requires a value.`);
    }
    if (argument === "--state-dir") {
      options.stateDirectory = resolve(value);
    } else if (argument === "--host") {
      options.host = value;
    } else if (argument === "--port") {
      const port = Number(value);
      if (!Number.isInteger(port) || port < 0 || port > 65_535) {
        throw new Error("--port must be an integer between 0 and 65535.");
      }
      options.port = port;
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

const isMain =
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  void runCli().catch((error) => {
    process.stderr.write(`${formatError(error)}\n`);
    process.exitCode = 1;
  });
}
