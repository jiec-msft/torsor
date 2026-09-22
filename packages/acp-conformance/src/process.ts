import { fork, spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Writable } from "node:stream";

import { deferred, HarnessError, record } from "./facts.js";
import type { Limits } from "./schema.js";

export interface Launch {
  command: string;
  args: readonly string[];
  environment?: Readonly<Record<string, string>>;
}

export function isolatedEnvironment(workspace: string): Record<string, string> {
  const environment: Record<string, string> = {};
  const allowed = new Set(["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "LANG", "LC_ALL"]);
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && allowed.has(key.toUpperCase())) environment[key] = value;
  }
  for (const key of [
    "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP",
    "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME",
  ]) environment[key] = workspace;
  return environment;
}

export class OwnedProcess {
  readonly #owner: ChildProcess;
  readonly #failure = deferred<HarnessError>();
  readonly #started = deferred<void>();
  readonly #exit = deferred<{ code: number | null; signal: string | null }>();
  readonly #closed = deferred<void>();
  readonly #stdoutEnd = deferred<void>();
  readonly #stderrEnd = deferred<void>();
  readonly failure = this.#failure.promise;
  readonly exited = this.#exit.promise;
  readonly started = this.#started.promise;
  readonly stdoutEnded = this.#stdoutEnd.promise;
  readonly stderrEnded = this.#stderrEnd.promise;
  readonly stdout: NonNullable<ChildProcess["stdout"]>;
  readonly stdin: Writable;
  #failed: HarnessError | undefined;
  #closedOwner = false;
  #ending = false;
  #stdoutBytes = 0;
  #stdoutTarget: number | undefined;
  #stderrTarget: number | undefined;
  stderrBytes = 0;
  startupStage = "owner initialization";

  constructor(launch: Launch, workspace: string, limits: Limits, mock = false) {
    this.#owner = fork(fileURLToPath(new URL("./owner.js", import.meta.url)), [], {
      cwd: workspace, env: isolatedEnvironment(workspace), execArgv: [],
      stdio: ["pipe", "pipe", "pipe", "ipc"], windowsHide: true,
      detached: process.platform !== "win32",
    });
    this.stdout = this.#owner.stdout!;
    this.stdout.once("end", () => this.#stdoutEnd.resolve());
    this.stdout.on("data", (chunk: Buffer) => {
      this.#stdoutBytes += chunk.length;
      this.resolveOutputEnd();
    });
    this.stdin = this.#owner.stdin!;
    this.#owner.stderr!.on("data", (chunk: Buffer) => {
      this.stderrBytes += chunk.length;
      if (this.stderrBytes > limits.stderrBytes) this.fail("stderr_limit", "Provider stderr exceeded its byte budget.");
      this.resolveOutputEnd();
    });
    this.stdin.on("error", () => {
      if (!this.#ending) this.fail("stdin_closed", "Provider input pipe closed while writing.");
    });
    this.#owner.on("error", () => this.fail("spawn_failed", "Could not start the owned provider process."));
    this.#owner.once("close", () => {
      this.#closedOwner = true;
      this.#closed.resolve();
      if (!this.#ending) this.fail("process_exit", "Process owner exited before cleanup.");
    });
    this.#owner.on("message", (message: unknown) => {
      if (!record(message)) return;
      switch (message.type) {
        case "owner-ready":
          this.startupStage = "owner configuration";
          this.#owner.send({
            ...launch, args: [...launch.args], cwd: workspace, mock,
            environment: { ...isolatedEnvironment(workspace), ...launch.environment },
          }, (error) => { if (error) this.fail("spawn_failed", "Could not configure the owned process."); });
          break;
        case "ownership-starting": this.startupStage = "process ownership setup"; break;
        case "guardian": this.startupStage = "job guardian compilation"; break;
        case "compiled": this.startupStage = "job assignment"; break;
        case "ownership-ready": this.startupStage = "provider spawn"; break;
        case "started": this.#started.resolve(); break;
        case "spawn-error": this.fail("spawn_failed", "Could not start the configured provider command."); break;
        case "ownership-error": this.fail("cleanup_failed", "Could not establish process ownership; provider was not started."); break;
        case "stdin-error": if (!this.#ending) this.fail("stdin_closed", "Provider closed its input pipe."); break;
        case "stdout-end":
          if (typeof message.bytes === "number") { this.#stdoutTarget = message.bytes; this.resolveOutputEnd(); }
          break;
        case "stderr-end":
          if (typeof message.bytes === "number") { this.#stderrTarget = message.bytes; this.resolveOutputEnd(); }
          break;
        case "exit":
          this.#exit.resolve({
            code: typeof message.code === "number" ? message.code : null,
            signal: typeof message.signal === "string" ? message.signal : null,
          });
          break;
      }
    });
  }

  fail(code: string, message: string): void {
    if (!this.#failed) {
      this.#failed = new HarnessError(code, message);
      this.#failure.resolve(this.#failed);
    }
  }

  get error(): HarnessError | undefined { return this.#failed; }

  private resolveOutputEnd(): void {
    if (this.#stdoutTarget !== undefined && this.#stdoutBytes >= this.#stdoutTarget) this.#stdoutEnd.resolve();
    if (this.#stderrTarget !== undefined && this.stderrBytes >= this.#stderrTarget) this.#stderrEnd.resolve();
  }

  async write(chunk: Uint8Array): Promise<void> {
    if (this.stdin.destroyed || this.stdin.writableEnded) {
      throw new HarnessError("stdin_closed", "Provider input is not writable.");
    }
    await new Promise<void>((resolve, reject) => {
      this.stdin.write(chunk, (error) => {
        if (error) reject(new HarnessError("stdin_closed", "Provider input write failed."));
        else resolve();
      });
    });
  }

  endInput(): void {
    if (!this.stdin.destroyed && !this.stdin.writableEnded) this.stdin.end();
  }

  async cleanup(timeoutMs: number): Promise<void> {
    const until = performance.now() + timeoutMs;
    const remaining = () => Math.max(1, until - performance.now());
    this.#ending = true;
    this.endInput();
    const pid = this.#owner.pid;
    if (pid && !this.#closedOwner) {
      if (process.platform === "win32") {
        await new Promise<void>((resolve, reject) => {
          const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
            shell: false, windowsHide: true, stdio: "ignore",
          });
          const timer = setTimeout(() => {
            killer.kill();
            reject(new HarnessError("cleanup_failed", "Owned process-tree termination exceeded its deadline."));
          }, remaining());
          killer.once("error", () => {
            clearTimeout(timer);
            reject(new HarnessError("cleanup_failed", "Could not start process-tree termination."));
          });
          killer.once("close", (code) => {
            clearTimeout(timer);
            if (code !== 0 && !this.#closedOwner) reject(new HarnessError("cleanup_failed", "Owned process-tree termination failed."));
            else resolve();
          });
        });
      } else {
        try { process.kill(-pid, "SIGKILL"); }
        catch (error) {
          if (!record(error) || error.code !== "ESRCH") {
            throw new HarnessError("cleanup_failed", "Owned process-group termination failed.");
          }
        }
      }
    }
    await deadline(this.#closed.promise, remaining(), "cleanup_failed");
  }
}

export async function deadline<T>(promise: Promise<T>, ms: number, code = "timeout"): Promise<T> {
  const result = await within(promise, ms);
  if (!result.done) throw new HarnessError(code, "Operation exceeded its configured deadline.");
  return result.value;
}

export async function within<T>(promise: Promise<T>, ms: number): Promise<{ done: true; value: T } | { done: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then((value) => ({ done: true as const, value })),
      new Promise<{ done: false }>((resolve) => {
        timer = setTimeout(() => resolve({ done: false }), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
