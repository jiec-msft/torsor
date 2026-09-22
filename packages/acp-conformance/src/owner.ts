import { spawn } from "node:child_process";

const send = (type: string, fields: Record<string, unknown> = {}) => {
  if (process.connected) process.send?.({ type, ...fields });
};

// Keep IPC referenced after provider exit and reclaim the group if the caller disappears.
process.once("disconnect", () => {
  if (process.platform !== "win32") process.kill(-process.pid, "SIGKILL");
  else process.exit(0);
});

process.once("message", async (configuration: {
  command: string; args: string[]; cwd: string; environment: Record<string, string>; mock: boolean;
}) => {
  send("ownership-starting");
  if (process.platform === "win32") {
    try {
      const { createWindowsJob } = await import("./windows-job.js");
      createWindowsJob();
    }
    catch { send("ownership-error"); return; }
  }
  send("ownership-ready");
  const child = spawn(configuration.command, configuration.args, {
    cwd: configuration.cwd, env: configuration.environment,
    shell: false, windowsHide: true,
    stdio: configuration.mock ? ["pipe", "pipe", "pipe", "ipc"] : ["pipe", "pipe", "pipe"],
  });
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stdoutEnd: number | undefined;
  const endOutput = () => {
    if (stdoutEnd !== undefined && stdoutBytes >= stdoutEnd) {
      send("stdout-end", { bytes: stdoutEnd });
      stdoutEnd = undefined;
    }
  };
  child.once("spawn", () => send("started"));
  child.once("error", () => send("spawn-error"));
  child.once("exit", (code, signal) => send("exit", { code, signal }));
  child.stdin!.on("error", () => { process.stdin.unpipe(child.stdin!); send("stdin-error"); });
  child.stdout!.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    endOutput();
  });
  child.stdout!.once("end", () => { stdoutEnd = stdoutBytes; endOutput(); });
  child.stderr!.on("data", (chunk: Buffer) => { stderrBytes += chunk.length; });
  child.stderr!.once("end", () => send("stderr-end", { bytes: stderrBytes }));
  if (configuration.mock) {
    child.on("message", (message: unknown) => {
      if (typeof message !== "object" || message === null) return;
      if ("type" in message && message.type === "stdout-close" && "bytes" in message && typeof message.bytes === "number") {
        stdoutEnd = message.bytes;
        endOutput();
      } else if ("type" in message && message.type === "stdin-close") {
        child.stdin!.destroy();
        send("stdin-error");
      }
    });
  }
  process.stdin.pipe(child.stdin!);
  child.stdout!.pipe(process.stdout, { end: false });
  child.stderr!.pipe(process.stderr, { end: false });
});

send("owner-ready");
