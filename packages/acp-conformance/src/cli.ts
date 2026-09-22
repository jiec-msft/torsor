#!/usr/bin/env node
import { mkdir, open } from "node:fs/promises";
import { extname } from "node:path";

import { ConfigurationError, loadScenario, runSuite, type RunOptions } from "./index.js";
import { ArtifactError, writeArtifacts } from "./artifacts.js";

const usage = "Usage: acp-conformance run <scenario...> [--out <directory>] [--allow-real] [--inherit-env NAME] [--profile copilot-cli-v1 | -- <command> <args...>]\n       acp-conformance mock <scenario>";

async function readScenario(path: string) {
  const extension = extname(path).toLowerCase();
  if (![".json", ".yaml", ".yml"].includes(extension)) throw new ConfigurationError(["$"], "Scenario file must be JSON or YAML.");
  const handle = await open(path, "r");
  try {
    if (!(await handle.stat()).isFile()) throw new ConfigurationError(["$"], "Scenario input must be a regular file.");
    const buffer = Buffer.alloc(262_145);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    return loadScenario(buffer.subarray(0, size).toString("utf8"), { format: extension === ".json" ? "json" : "yaml" });
  } finally { await handle.close(); }
}

async function main(): Promise<number> {
  const [operation, ...args] = process.argv.slice(2);
  if (operation === "--help") { console.log(usage); return 0; }
  if (operation === "mock" && args.length === 1) {
    const { serveMock } = await import("./mock.js");
    await serveMock(await readScenario(args[0]!));
    return 0;
  }
  if (operation !== "run") throw new ConfigurationError(["$"], usage);
  const paths: string[] = [];
  let out: string | undefined;
  let profile = false;
  const options: RunOptions = {};
  const environment: Record<string, string> = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    const next = () => {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new ConfigurationError(["$"], "Option requires a value.");
      return value;
    };
    if (arg === "--") {
      if (profile || !args[index + 1]) throw new ConfigurationError(["$.provider"], "Select one provider command or profile.");
      options.provider = { command: args[index + 1]!, args: args.slice(index + 2), environment };
      break;
    }
    if (arg === "--allow-real" && !options.allowReal) options.allowReal = true;
    else if (arg === "--out" && !out) out = next();
    else if (arg === "--profile" && !profile) {
      if (next() !== "copilot-cli-v1") throw new ConfigurationError(["$.provider.profile"], "Unsupported compatibility profile.");
      profile = true;
      options.provider = { profile: "copilot-cli-v1", environment };
    } else if (arg === "--inherit-env") {
      const name = next();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || Object.hasOwn(environment, name) || process.env[name] === undefined) {
        throw new ConfigurationError(["$.provider.environment"], "Explicit environment name is invalid, duplicated, or unavailable.");
      }
      environment[name] = process.env[name]!;
    } else if (arg.startsWith("--")) throw new ConfigurationError(["$"], "Unknown or repeated option.");
    else paths.push(arg);
  }
  if (!paths.length) throw new ConfigurationError(["$"], usage);
  if (!options.provider && Object.keys(environment).length) throw new ConfigurationError(["$.provider"], "Environment forwarding requires an external provider.");
  const scenarios = [];
  for (const path of paths) scenarios.push(await readScenario(path));
  if (new Set(scenarios.map((scenario) => scenario.id.toLowerCase())).size !== scenarios.length) {
    throw new ConfigurationError(["$.id"], "Scenario IDs must be unique within a suite.");
  }
  const results = await runSuite(scenarios, options);
  if (out) await mkdir(out, { recursive: true });
  for (const result of results) {
    if (out) await writeArtifacts(out, result);
    console.log(`${result.status.toUpperCase()} ${result.id}`);
    for (const diagnostic of result.diagnostics) {
      console.log(`  step ${diagnostic.step}: ${diagnostic.code}: ${diagnostic.message}`);
    }
  }
  return results.some((result) => result.status === "failed") ? 1
    : results.some((result) => result.status === "skipped") ? 3 : 0;
}

try { process.exitCode = await main(); }
catch (error) {
  console.error(error instanceof ConfigurationError || error instanceof ArtifactError ? error.message : "Could not read scenario or write artifacts.");
  process.exitCode = 2;
}
