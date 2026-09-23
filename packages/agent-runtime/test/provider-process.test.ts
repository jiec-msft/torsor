import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
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
  it.runIf(process.platform === "win32")(
    "uses one fixed packaged owner module for concurrent Windows launches",
    async () => {
      const owners = Array.from({ length: 2 }, () => new OwnedProviderProcess({
        command: process.execPath, cwd: process.cwd(), environment: {},
        args: ["-e", "process.stdout.write('ready');process.stdin.resume();"],
      }));
      try {
        const ownerModules = owners.map((owner) => owner.processHandle.spawnargs[1]);
        expect(new Set(ownerModules).size).toBe(1);
        expect(ownerModules[0]).toSatisfy(
          (value: unknown) => typeof value === "string" && isAbsolute(value),
        );
        for (const owner of owners) {
          expect(owner.processHandle.spawnfile).toBe(process.execPath);
          expect(owner.processHandle.spawnargs.join("\n")).toMatch(
            /provider-process-windows-owner\.js/,
          );
          expect(owner.processHandle.spawnargs.join("\n")).not.toMatch(
            /powershell|Add-Type|TypeDefinition/i,
          );
        }
        await Promise.all(owners.map(ready));
      } finally {
        for (const owner of owners) owner.forceStop();
        await Promise.all(owners.map((owner) => Promise.allSettled([owner.closed])));
      }
    },
    150_000,
  );

  it.runIf(process.platform === "win32")(
    "fails closed on a corrupt Windows owner handshake",
    async () => {
      const ownerModule = fileURLToPath(new URL(
        "../dist/provider-process-windows-owner.js",
        import.meta.url,
      ));
      const owner = spawn(process.execPath, [ownerModule], {
        cwd: process.cwd(),
        env: {},
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      owner.stdin.end(Buffer.from([0xff, 0xff, 0x7f, 0x00]));
      const [code, signal] = await once(owner, "close");
      expect({ code, signal }).toEqual({ code: 125, signal: null });
    },
    30_000,
  );

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
    const timeout = setTimeout(() => owner.forceStop(), 120_000);
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
  }, 150_000);

  it("does not treat abrupt owner loss as whole-tree stop confirmation", async () => {
    const owner = new OwnedProviderProcess({
      command: process.execPath, cwd: process.cwd(), environment: {},
      args: ["-e", "process.stdout.write('ready');process.stdin.resume();"],
    });
    const timeout = setTimeout(() => owner.forceStop(), 120_000);
    try {
      await ready(owner);
      owner.forceStop();
      await expect(owner.closed).rejects.toMatchObject({ outcome: "Unknown" });
    } finally {
      clearTimeout(timeout);
      owner.forceStop();
      await Promise.allSettled([owner.closed]);
    }
  }, 150_000);
});
