import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const runFile = promisify(execFile);

export async function createDetachedWorktree(input: {
  readonly repositoryPath: string;
  readonly rootPath: string;
  readonly directoryName: string;
  readonly baseRevision: string;
  readonly signal?: AbortSignal;
}): Promise<void> {
  const target = join(input.rootPath, input.directoryName);
  if (existsSync(target)) {
    throw new Error("Unregistered Worktree directory exists; explicit reconciliation is required.");
  }
  const configuration = await mkdtemp(join(input.rootPath, ".torsor-provision-"));
  const configFile = join(configuration, "config");
  const hooks = join(configuration, "hooks");
  try {
    await writeFile(configFile, "", { flag: "wx" });
    await mkdir(hooks);
    const environment: Record<string, string> = {
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: configFile,
      GIT_CONFIG_COUNT: "0", GIT_TERMINAL_PROMPT: "0",
    };
    for (const [name, value] of Object.entries(process.env)) {
      if (value !== undefined && ["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR"].includes(name.toUpperCase())) {
        environment[name] = value;
      }
    }
    await runFile("git", [
      "-c", `core.hooksPath=${hooks}`, "-c", "core.fsmonitor=false",
      "worktree", "add", "--quiet", "--detach", "--", target, input.baseRevision,
    ], {
      cwd: input.repositoryPath, env: environment, windowsHide: true,
      timeout: 30_000, maxBuffer: 64 * 1024,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } finally {
    await rm(configuration, { recursive: true, force: true });
  }
}
