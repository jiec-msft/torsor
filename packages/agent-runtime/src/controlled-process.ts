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
process.on("message", (message) => {
  if (message.type === "probe") {
    process.send({ digest: createHash("sha256").update(message.content).digest("hex") });
  } else if (message.type === "stop") {
    process.disconnect();
  }
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
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    let resolveResult!: (value: string) => void;
    let rejectResult!: (error: Error) => void;
    const result = new Promise<string>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    void result.catch(() => undefined);
    let error: string | null = null;
    child.on("error", (failure) => { error = failure.message; rejectResult(failure); });
    child.on("message", (message: unknown) => {
      if (message !== null && typeof message === "object" && "digest" in message &&
          typeof message.digest === "string" && /^[a-f0-9]{64}$/.test(message.digest)) {
        resolveResult(message.digest);
      } else {
        rejectResult(new Error("Invalid controlled child result."));
      }
    });
    const closed = new Promise<ChildCloseEvidence>((resolve) => {
      child.once("close", (code, signal) => {
        rejectResult(new Error(error ?? "Controlled child closed before returning a digest."));
        resolve({ code, signal, error });
      });
    });
    const send = (message: object) => {
      if (child.connected) {
        child.send(message, (failure) => {
          if (failure) { error = failure.message; rejectResult(failure); }
        });
      }
    };
    child.once("spawn", () => send({ type: "probe", content: input.content }));
    return {
      pid: child.pid, result, closed,
      requestStop: () => send({ type: "stop" }),
      forceStop: () => child.kill("SIGKILL"),
    };
  },
};
