import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import type { CopilotAcpLaunchConfiguration } from "./copilot-acp-adapter.js";
import type { ChildCloseEvidence, ControlledChild } from "./controlled-process.js";
import { linuxOwnerSource } from "./provider-process-owner.js";
import { ProviderExecutionError } from "./types.js";

// The owner stays alive until the whole contained tree is stopped. Its exit alone
// is not evidence: abrupt owner loss deliberately leaves the receipt uncertain.
export class OwnedProviderProcess implements ControlledChild {
  readonly processHandle: ChildProcessWithoutNullStreams;
  readonly started: Promise<void>;
  readonly providerExit: Promise<void>;
  readonly closed: Promise<ChildCloseEvidence>;
  readonly result = Promise.resolve("");
  #exited = false;
  #providerExited = false;

  constructor(launch: CopilotAcpLaunchConfiguration) {
    const marker = `torsor-stop-${randomBytes(24).toString("hex")}:`;
    const exitMarker = `torsor-exit-${randomBytes(24).toString("hex")}:`;
    let command: string;
    let args: string[];
    let environment: Record<string, string>;
    let configuration: Buffer;
    if (process.platform === "win32") {
      const systemRoot = process.env.SystemRoot;
      if (!systemRoot) throw new ProviderExecutionError("provider_process_start_failed", "Failed");
      const applicationPath = resolveWindowsApplication(
        launch.command,
        launch.environment,
      );
      command = process.execPath;
      const commandLine = [applicationPath, ...launch.args].map(quoteWindowsArgument).join(" ");
      const providerEnvironment = Object.entries({
        ...(!Object.keys(launch.environment).some((key) => key.toUpperCase() === "SYSTEMROOT")
          ? { SystemRoot: systemRoot } : {}), ...launch.environment,
      })
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, value]) => `${name}=${value}\0`).join("") + "\0";
      args = [fileURLToPath(new URL(
        "../dist/provider-process-windows-owner.js",
        import.meta.url,
      ))];
      environment = Object.fromEntries(Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined &&
          ["SYSTEMROOT", "WINDIR", "TEMP", "TMP", "PATH", "PATHEXT"].includes(entry[0].toUpperCase()),
      ));
      configuration = Buffer.concat([
        applicationPath,
        commandLine,
        marker,
        exitMarker,
        providerEnvironment,
        launch.cwd,
      ].map(frame));
    } else if (process.platform === "linux") {
      command = process.execPath;
      args = ["--input-type=module", "--eval", linuxOwnerSource];
      environment = {};
      configuration = frame(JSON.stringify({ ...launch, marker, exitMarker }));
    } else {
      throw new ProviderExecutionError("provider_process_start_failed", "Failed");
    }
    const child = spawn(command, args, {
      cwd: launch.cwd, env: environment, shell: false, windowsHide: true,
      detached: process.platform === "linux", stdio: ["pipe", "pipe", "pipe"],
    });
    this.processHandle = child;
    let inputFailed = false;
    child.stdin.on("error", () => {
      inputFailed = true;
    });
    child.stdin.write(configuration, () => configuration.fill(0));
    const failed = () => new ProviderExecutionError("provider_process_start_failed", "Unknown");
    this.started = new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", () => reject(failed()));
    });
    let resolveProviderExit!: () => void;
    let rejectProviderExit!: (error: ProviderExecutionError) => void;
    this.providerExit = new Promise((resolve, reject) => {
      resolveProviderExit = resolve;
      rejectProviderExit = reject;
    });
    let tail = "";
    let evidence: ChildCloseEvidence | undefined;
    child.stderr.on("data", (chunk: Buffer) => {
      tail = (tail + chunk.toString("utf8")).slice(-512);
      const exitMatch = new RegExp(`${exitMarker}([0-9]{1,10})\\r?\\n`).exec(tail);
      if (exitMatch && !this.#providerExited) {
        this.#providerExited = true;
        resolveProviderExit();
      }
      const match = new RegExp(`${marker}([0-9]{1,10})\\r?\\n`).exec(tail);
      if (match) evidence = { code: Number(match[1]), signal: null, error: null };
    });
    this.closed = new Promise((resolve, reject) => {
      child.once("close", () => {
        this.#exited = true;
        if (!this.#providerExited) rejectProviderExit(failed());
        if (evidence) resolve({ ...evidence, error: inputFailed ? "Provider input failed." : null });
        else reject(failed());
      });
    });
    // The executor observes these failures and quarantines missing stop evidence.
    void this.started.catch(() => undefined);
    void this.providerExit.catch(() => undefined);
    void this.closed.catch(() => undefined);
  }

  get pid(): number | undefined { return this.processHandle.pid; }

  requestStop(): void { this.processHandle.stdin.end(); }

  forceStop(): boolean {
    if (this.#exited) return false;
    if (process.platform === "linux" && this.pid) {
      process.kill(-this.pid, "SIGKILL");
      return true;
    }
    return this.processHandle.kill("SIGKILL");
  }
}

function resolveWindowsApplication(
  command: string,
  environment: Readonly<Record<string, string>>,
): string {
  if (isAbsolute(command)) {
    try {
      return realApplicationPath(command);
    } catch {
      throw startFailure();
    }
  }
  if (win32.basename(command) !== command || command.length === 0) {
    throw new ProviderExecutionError("provider_process_start_failed", "Failed");
  }
  const path = environmentValue(environment, "PATH");
  if (!path) throw new ProviderExecutionError("provider_process_start_failed", "Failed");
  const extension = win32.extname(command);
  const extensions = extension
    ? [""]
    : (environmentValue(environment, "PATHEXT") ?? ".EXE")
        .split(";")
        .map((value) => value.trim())
        .filter((value) => /^\.[A-Za-z0-9]+$/.test(value));
  if (extensions.length === 0) {
    throw new ProviderExecutionError("provider_process_start_failed", "Failed");
  }
  for (const directory of path.split(delimiter)) {
    if (!win32.isAbsolute(directory)) continue;
    for (const suffix of extensions) {
      try {
        return realApplicationPath(win32.join(directory, command + suffix));
      } catch (error) {
        if (!(error instanceof Error && "code" in error &&
          (error.code === "ENOENT" || error.code === "ENOTDIR"))) {
          throw startFailure();
        }
      }
    }
  }
  throw startFailure();
}

function realApplicationPath(path: string): string {
  const resolved = realpathSync.native(path);
  if (!statSync(resolved).isFile()) {
    throw startFailure();
  }
  return resolved;
}

function environmentValue(
  environment: Readonly<Record<string, string>>,
  expected: string,
): string | undefined {
  const matches = Object.entries(environment).filter(
    ([name]) => name.toUpperCase() === expected,
  );
  if (matches.length > 1) {
    throw startFailure();
  }
  return matches[0]?.[1];
}

function startFailure(): ProviderExecutionError {
  return new ProviderExecutionError("provider_process_start_failed", "Failed");
}

function quoteWindowsArgument(value: string): string {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")}"`;
}

function frame(value: string): Buffer {
  const content = Buffer.from(value, "utf16le");
  if (content.length > 1024 * 1024) throw new ProviderExecutionError("provider_process_start_failed", "Failed");
  const length = Buffer.alloc(4);
  length.writeInt32LE(content.length);
  return Buffer.concat([length, content]);
}
