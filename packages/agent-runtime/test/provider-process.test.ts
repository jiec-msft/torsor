import { once } from "node:events";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OwnedProviderProcess } from "../src/provider-process.js";

async function ready(owner: OwnedProviderProcess): Promise<unknown> {
  const output = once(owner.processHandle.stdout, "data").then(([chunk]) => chunk);
  const exited = once(owner.processHandle, "exit").then(([code]) => {
    throw new Error(`Synthetic process owner exited before readiness with code ${String(code)}.`);
  });
  return Promise.race([output, exited]);
}

describe("retained native process-tree owner", () => {
  it("stops descendants before confirming normal parent completion", async () => {
    const owner = new OwnedProviderProcess({
      command: process.execPath, cwd: process.cwd(), environment: {},
      args: ["-e", `
        const child = require("node:child_process").spawn(process.execPath,
          ["-e", "setInterval(()=>{},1000)"], {stdio:"ignore"});
        process.stdout.write(child.pid+"\\n");
        process.stdin.resume();
        process.stdin.on("end",()=>process.exit(0));
      `],
    });
    const timeout = setTimeout(() => owner.forceStop(), 30_000);
    try {
      const chunk = await ready(owner);
      const pid = Number(String(chunk).trim());
      expect(pid).toBeGreaterThan(0);
      process.kill(pid, 0);
      owner.requestStop();
      await expect(owner.closed).resolves.toEqual({ code: 0, signal: null, error: null });
      if (process.platform === "linux") {
        let state: string | undefined;
        try {
          const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
          state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
        expect([undefined, "Z", "X"]).toContain(state);
      } else expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      clearTimeout(timeout);
      owner.forceStop();
      await Promise.allSettled([owner.closed]);
    }
  }, 45_000);

  it("does not treat abrupt owner loss as whole-tree stop confirmation", async () => {
    const owner = new OwnedProviderProcess({
      command: process.execPath, cwd: process.cwd(), environment: {},
      args: ["-e", "process.stdout.write('ready');process.stdin.resume();"],
    });
    const timeout = setTimeout(() => owner.forceStop(), 30_000);
    try {
      await ready(owner);
      owner.forceStop();
      await expect(owner.closed).rejects.toMatchObject({ outcome: "Unknown" });
    } finally {
      clearTimeout(timeout);
      owner.forceStop();
      await Promise.allSettled([owner.closed]);
    }
  }, 45_000);
});
