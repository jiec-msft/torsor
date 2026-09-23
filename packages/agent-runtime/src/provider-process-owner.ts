export const linuxOwnerSource = String.raw`
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, readSync } from "node:fs";
function readExact(length) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const count = readSync(0, buffer, offset, length - offset);
    if (!count) process.exit(125);
    offset += count;
  }
  return buffer;
}
const length = readExact(4).readInt32LE();
if (length < 0 || length > 1048576) process.exit(125);
const launch = JSON.parse(readExact(length).toString("utf16le"));
process.on("SIGTERM", () => {});
const child = spawn(launch.command, launch.args, {
  cwd: launch.cwd, env: launch.environment, stdio: [0, 1, 2], shell: false,
});
child.on("error", () => process.exit(125));
function liveGroupMembers() {
  return readdirSync("/proc").filter((name) => /^[0-9]+$/.test(name) && Number(name) !== process.pid)
    .filter((name) => {
      let stat;
      try { stat = readFileSync("/proc/" + name + "/stat", "utf8"); }
      catch (error) { if (error.code === "ENOENT" || error.code === "ESRCH") return false; throw error; }
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return Number(fields[2]) === process.pid && fields[0] !== "Z" && fields[0] !== "X";
    });
}
child.on("exit", (code, signal) => {
  process.stderr.write(launch.exitMarker + (signal ? 137 : code) + "\n");
  // The living group leader pins the original process-group identity during stop.
  process.kill(-process.pid, "SIGTERM");
  const deadline = Date.now() + 750;
  const timer = setInterval(() => {
    try {
      if (liveGroupMembers().length === 0) {
        clearInterval(timer);
        process.stderr.write(launch.marker + (signal ? 137 : code) + "\n", () => process.exit(0));
      } else if (Date.now() >= deadline) {
        // No false confirmation if escalation also destroys the retained owner.
        process.kill(-process.pid, "SIGKILL");
      }
    } catch { process.kill(-process.pid, "SIGKILL"); }
  }, 5);
});
`;
