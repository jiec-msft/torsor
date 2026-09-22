import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

if (process.argv[2] === "--child") {
  process.send?.("ready");
  setInterval(() => {}, 60_000);
} else {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--child"], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  child.once("message", () => {
    writeFileSync(process.argv[2], String(child.pid));
    child.disconnect();
    child.unref();
    process.exit(0);
  });
}
