import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { CopilotAcpLaunchConfiguration } from "./copilot-acp-adapter.js";
import type { ChildCloseEvidence, ControlledChild } from "./controlled-process.js";
import { windowsOwnerSource, linuxOwnerSource } from "./provider-process-owner.js";
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

  constructor(launch: CopilotAcpLaunchConfiguration) {
    const marker = `torsor-stop-${randomBytes(24).toString("hex")}:`;
    let command: string;
    let args: string[];
    let environment: Record<string, string>;
    let configuration: Buffer;
    if (process.platform === "win32") {
      const systemRoot = process.env.SystemRoot;
      if (!systemRoot) throw new ProviderExecutionError("provider_process_start_failed", "Failed");
      command = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const commandLine = [launch.command, ...launch.args].map(quoteWindowsArgument).join(" ");
      const providerEnvironment = Object.entries({
        ...(!Object.keys(launch.environment).some((key) => key.toUpperCase() === "SYSTEMROOT")
          ? { SystemRoot: systemRoot } : {}), ...launch.environment,
      })
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, value]) => `${name}=${value}\0`).join("") + "\0";
      const source = `$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\ntry {\nAdd-Type -TypeDefinition @'\n${windowsOwnerSource}\n'@\n`
        + `exit [TorsorProcessOwner]::Run()\n} catch { exit 125 }\n`;
      args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
        Buffer.from(source, "utf16le").toString("base64")];
      environment = Object.fromEntries(Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined &&
          ["SYSTEMROOT", "WINDIR", "TEMP", "TMP", "PATH", "PATHEXT"].includes(entry[0].toUpperCase()),
      ));
      configuration = Buffer.concat([commandLine, marker, providerEnvironment, launch.cwd].map(frame));
    } else if (process.platform === "linux") {
      command = process.execPath;
      args = ["--input-type=module", "--eval", linuxOwnerSource];
      environment = {};
      configuration = frame(JSON.stringify({ ...launch, marker }));
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
    this.providerExit = new Promise((resolve) => {
      child.once("exit", () => { this.#exited = true; resolve(); });
      child.once("error", () => { this.#exited = true; resolve(); });
    });
    let tail = "";
    let evidence: ChildCloseEvidence | undefined;
    child.stderr.on("data", (chunk: Buffer) => {
      tail = (tail + chunk.toString("utf8")).slice(-512);
      const match = new RegExp(`${marker}([0-9]{1,10})\\r?\\n`).exec(tail);
      if (match) evidence = { code: Number(match[1]), signal: null, error: null };
    });
    this.closed = new Promise((resolve, reject) => {
      child.once("close", () => evidence
        ? resolve({ ...evidence, error: inputFailed ? "Provider input failed." : null }) : reject(failed()));
    });
    // The executor observes these failures and quarantines missing stop evidence.
    void this.started.catch(() => undefined);
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
