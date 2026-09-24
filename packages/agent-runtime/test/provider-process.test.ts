import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildCopilotProviderEnvironment } from "../src/copilot-provider-environment.js";
import { OwnedProviderProcess } from "../src/provider-process.js";
import { resolveProviderPolicy } from "../src/provider-policy.js";

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

  it.runIf(process.platform === "win32")(
    "resolves a bare executable only through the provider PATH and PATHEXT",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "torsor provider 路径 "));
      const executable = join(root, "synthetic-provider.EXE");
      copyFileSync(process.execPath, executable);
      const owner = new OwnedProviderProcess({
        command: "synthetic-provider",
        cwd: process.cwd(),
        environment: buildCopilotProviderEnvironment(
          resolveProviderPolicy({
            kind: "trusted-local",
            permissionMode: "provider-default",
          }),
          { pAtH: root, PaThExT: ".EXE" },
        ),
        args: [
          "-e",
          "process.stdout.write('ready:'+process.argv[1]);process.stdin.resume();",
          "argument with 空格",
        ],
      });
      try {
        expect(String(await ready(owner))).toBe("ready:argument with 空格");
      } finally {
        owner.requestStop();
        await Promise.allSettled([owner.closed]);
        rmSync(root, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it.runIf(process.platform === "win32")(
    "rejects an injected Windows environment block before owner or provider start",
    async () => {
      let owner: OwnedProviderProcess | undefined;
      let rejection: unknown;
      try {
        try {
          owner = new OwnedProviderProcess({
            command: process.execPath,
            cwd: process.cwd(),
            environment: buildCopilotProviderEnvironment(
              resolveProviderPolicy({
                kind: "trusted-local",
                permissionMode: "provider-default",
              }),
              {
                SYNTHETIC_SAFE:
                  "value\0TORSOR_AUTH_TOKEN=synthetic-smuggled",
              },
            ),
            args: [
              "-e",
              "process.stdout.write(process.env.TORSOR_AUTH_TOKEN??'missing');process.stdin.resume();",
            ],
          });
        } catch (error) {
          rejection = error;
        }
        if (owner) {
          expect(String(await ready(owner))).toBe("missing");
        }
        expect(rejection).toMatchObject({
          message: "Invalid provider environment.",
        });
        expect(owner).toBeUndefined();
      } finally {
        owner?.forceStop();
        if (owner) await Promise.allSettled([owner.closed]);
      }
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

  it.runIf(process.platform === "win32")(
    "confirms forced stop of an unresponsive Provider and descendant through the original owner",
    async () => {
      const owner = new OwnedProviderProcess({
        command: process.execPath, cwd: process.cwd(), environment: {},
        args: ["-e", `
          const child = require("node:child_process").spawn(process.execPath,
            ["-e", "setInterval(()=>{},1000)"], {stdio:"ignore"});
          process.stdout.write(child.pid+"\\n");
          process.stdin.resume();
          process.stdin.on("end",()=>setInterval(()=>{},1000));
        `],
      });
      const timeout = setTimeout(() => owner.processHandle.kill("SIGKILL"), 10_000);
      try {
        const pid = Number(String(await ready(owner)).trim());
        expect(pid).toBeGreaterThan(0);
        owner.requestStop();
        expect(owner.forceStop()).toBe(true);
        await expect(owner.closed).resolves.toEqual({ code: 137, signal: null, error: null });
        expect(() => process.kill(pid, 0)).toThrow();
      } finally {
        clearTimeout(timeout);
        owner.processHandle.kill("SIGKILL");
        await Promise.allSettled([owner.closed]);
      }
    },
    30_000,
  );

  it("does not treat abrupt owner loss as whole-tree stop confirmation", async () => {
    const owner = new OwnedProviderProcess({
      command: process.execPath, cwd: process.cwd(), environment: {},
      args: ["-e", "process.stdout.write('ready');process.stdin.resume();"],
    });
    const timeout = setTimeout(() => owner.forceStop(), 120_000);
    try {
      await ready(owner);
      if (process.platform === "win32") owner.processHandle.kill("SIGKILL");
      else owner.forceStop();
      await expect(owner.closed).rejects.toMatchObject({ outcome: "Unknown" });
    } finally {
      clearTimeout(timeout);
      owner.forceStop();
      await Promise.allSettled([owner.closed]);
    }
  }, 150_000);
});
