import { spawn } from "node:child_process";

export interface ChildCloseEvidence {
  readonly code: number | null;
  readonly signal: string | null;
  readonly error: string | null;
}

export interface ControlledChild {
  readonly pid: number | undefined;
  readonly result: Promise<string>;
  readonly closed: Promise<ChildCloseEvidence>;
  requestStop(): void;
  forceStop(): boolean;
}

// A trusted seam for deterministic process fixtures, not an arbitrary command API.
export interface ControlledProcessDriver {
  start(input: { readonly cwd: string; readonly content: string }): ControlledChild;
}

const probeSource = `
const { createHash } = require("node:crypto");
const input = require("node:readline").createInterface({ input: process.stdin });
input.once("line", (line) => {
  const message = JSON.parse(line);
  process.stdout.write(createHash("sha256").update(message.content).digest("hex") + "\\n");
});
`;

export const nodeProbeDriver: ControlledProcessDriver = {
  start(input) {
    const child = spawn(process.execPath, ["--input-type=commonjs", "-e", probeSource], {
      cwd: input.cwd,
      shell: false,
      windowsHide: true,
      // No inherited NODE_OPTIONS, preload, PATH, credentials, or repository environment.
      env: process.platform === "win32" && process.env.SystemRoot
        ? { SystemRoot: process.env.SystemRoot } : {},
      stdio: ["pipe", "pipe", "pipe"],
    });
    let resolveResult!: (value: string) => void;
    let rejectResult!: (error: Error) => void;
    const result = new Promise<string>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    void result.catch(() => undefined);
    let error: string | null = null;
    let output = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const fail = (message: string) => {
      rejectResult(new Error(message));
      if (error === null) {
        error = message;
        child.kill("SIGKILL");
      }
    };
    child.on("error", () => fail("Controlled child process failed."));
    child.stdin.on("error", () => fail("Controlled child input failed."));
    child.stdout.on("error", () => fail("Controlled child output failed."));
    child.stderr.on("error", () => fail("Controlled child diagnostics failed."));
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > 65) return fail("Controlled child exceeded its output limit.");
      if (chunk.some((byte) => byte > 127)) return fail("Invalid controlled child result.");
      output += chunk.toString("ascii");
      if (output.length === 65) {
        if (/^[a-f0-9]{64}\n$/.test(output)) resolveResult(output.slice(0, 64));
        else fail("Invalid controlled child result.");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > 1024) fail("Controlled child exceeded its diagnostic limit.");
    });
    const closed = new Promise<ChildCloseEvidence>((resolve) => {
      child.once("close", (code, signal) => {
        rejectResult(new Error(error ?? "Controlled child closed before returning a digest."));
        resolve({ code, signal, error });
      });
    });
    child.once("spawn", () => child.stdin.write(`${JSON.stringify({ content: input.content })}\n`));
    return {
      pid: child.pid, result, closed,
      requestStop: () => child.stdin.end(),
      forceStop: () => child.kill("SIGKILL"),
    };
  },
};
