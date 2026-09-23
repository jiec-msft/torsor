import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LocalWorktreeExecutor } from "@torsor/agent-runtime";
import type { TorsorKernel } from "@torsor/kernel";
import { ScriptedProcesses } from "./processes.js";

export class ScenarioWorktrees {
  readonly executor: LocalWorktreeExecutor;
  readonly processes: ScriptedProcesses | undefined;
  readonly #repository: string;
  readonly #root: string;
  readonly #config: string;
  readonly #hooks: string;
  readonly #base: string;

  constructor(directory: string, kernel: TorsorKernel, runtimePrincipalId: string, mode: "fixed" | "scripted") {
    const canonical = realpathSync.native(directory);
    this.#repository = join(canonical, "repository");
    this.#root = join(canonical, "managed");
    this.#config = join(canonical, "empty-gitconfig");
    this.#hooks = join(canonical, "empty-hooks");
    if (!existsSync(this.#repository)) {
      mkdirSync(this.#repository);
      mkdirSync(this.#root);
      mkdirSync(this.#hooks);
      writeFileSync(this.#config, "", { flag: "wx" });
      this.#git("init", "--quiet", "--template=");
      this.#git("commit", "--allow-empty", "--quiet", "-m", "Synthetic scenario base");
    }
    this.#base = this.#git("rev-parse", "HEAD");
    this.processes = mode === "scripted" ? new ScriptedProcesses() : undefined;
    this.executor = new LocalWorktreeExecutor({
      kernel, runtimePrincipalId, repositoryPath: this.#repository, rootPath: this.#root,
      ...(this.processes ? {
        driver: this.processes, leaseDurationMs: 1000, stopGraceMs: 10, forceGraceMs: 10,
      } : {}),
    });
  }

  #git(...args: string[]): string {
    return execFileSync("git", [
      "--no-pager", "-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid",
      "-c", "commit.gpgsign=false", "-c", `core.hooksPath=${this.#hooks}`, ...args,
    ], {
      cwd: this.#repository, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000,
      env: {
        PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
        GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: this.#config,
        GIT_CONFIG_COUNT: "0", GIT_TERMINAL_PROMPT: "0",
        GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
      },
    }).trim();
  }

  async register(runId: string): Promise<string> {
    const worktreeId = randomUUID();
    this.#git("worktree", "add", "--quiet", "--detach", join(this.#root, worktreeId), this.#base);
    await this.executor.register({
      worktreeId, runId, directoryName: worktreeId, baseRevision: this.#base,
    });
    return worktreeId;
  }

  async close(): Promise<void> {
    try { this.processes?.close(); } finally { await this.executor.close(); }
  }
}
