// Original local supervisors; no provider output or configuration is written to disk.
export const windowsOwnerSource = String.raw`
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Threading;
using System.IO;

public static class TorsorProcessOwner {
  [StructLayout(LayoutKind.Sequential)] struct Startup {
    public int cb; public IntPtr reserved, desktop, title;
    public int x, y, width, height, charsX, charsY, fill, flags;
    public short show, reservedSize; public IntPtr reservedBytes, input, output, error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
    public IntPtr process, thread; public int pid, tid;
  }
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long processTime, jobTime; public uint flags;
    public UIntPtr minWorkingSet, maxWorkingSet; public uint activeLimit;
    public UIntPtr affinity; public uint priority, scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters {
    public ulong readOps, writeOps, otherOps, readBytes, writeBytes, otherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct Limits {
    public BasicLimits basic; public IoCounters io;
    public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long user, kernel, periodUser, periodKernel;
    public uint faults, total, active, terminated;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool CreateProcess(string app, StringBuilder line, IntPtr pa, IntPtr ta,
    bool inherit, uint flags, IntPtr env, string cwd, ref Startup startup, out ProcessInfo process);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attrs, string name);
  [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int info, ref Limits value, int size);
  [DllImport("kernel32.dll")] static extern bool QueryInformationJobObject(IntPtr job, int info, out Accounting value, int size, IntPtr length);
  [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int id);
  [DllImport("kernel32.dll")] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

  static byte[] ReadField(BinaryReader input) {
    int length = input.ReadInt32();
    if (length < 0 || length > 1048576) throw new InvalidDataException();
    byte[] bytes = input.ReadBytes(length);
    if (bytes.Length != length) throw new EndOfStreamException();
    return bytes;
  }
  public static int Run() {
    BinaryReader input = new BinaryReader(Console.OpenStandardInput());
    string line = Encoding.Unicode.GetString(ReadField(input));
    string marker = Encoding.Unicode.GetString(ReadField(input));
    byte[] bytes = ReadField(input);
    string directory = Encoding.Unicode.GetString(ReadField(input));
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    ProcessInfo process = new ProcessInfo();
    bool assigned = false;
    IntPtr env = IntPtr.Zero;
    try {
      if (job == IntPtr.Zero) return 121;
      Limits limits = new Limits();
      limits.basic.flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
      if (!SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(Limits)))) return 122;
      Startup startup = new Startup();
      startup.cb = Marshal.SizeOf(typeof(Startup)); startup.flags = 0x100;
      startup.input = GetStdHandle(-10); startup.output = GetStdHandle(-11); startup.error = GetStdHandle(-12);
      foreach (IntPtr handle in new [] { startup.input, startup.output, startup.error })
        if (!SetHandleInformation(handle, 1, 1)) return 123;
      env = Marshal.AllocHGlobal(bytes.Length + 2);
      Marshal.Copy(bytes, 0, env, bytes.Length);
      Marshal.WriteInt16(env, bytes.Length, 0);
      // No provider instruction runs outside the job: create suspended, assign, then resume.
      if (!CreateProcess(null, new StringBuilder(line), IntPtr.Zero, IntPtr.Zero, true,
          0x08000404, env, directory, ref startup, out process)) return 124;
      if (!AssignProcessToJobObject(job, process.process)) return 126;
      assigned = true;
      if (ResumeThread(process.thread) == 0xffffffff) return 127;
      if (WaitForSingleObject(process.process, 0xffffffff) != 0) return 125;
      uint code;
      if (!GetExitCodeProcess(process.process, out code)) return 125;
      if (!TerminateJobObject(job, 137)) return 125;
      for (int i = 0; i < 200; i++) {
        Accounting accounting;
        if (!QueryInformationJobObject(job, 1, out accounting, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero)) return 125;
        if (accounting.active == 0) {
          Console.Error.WriteLine(marker + code); Console.Error.Flush();
          return 0;
        }
        Thread.Sleep(5);
      }
      return 125;
    } finally {
      if (process.process != IntPtr.Zero && !assigned) {
        TerminateProcess(process.process, 137);
        WaitForSingleObject(process.process, 1000);
      }
      if (process.thread != IntPtr.Zero) CloseHandle(process.thread);
      if (process.process != IntPtr.Zero) CloseHandle(process.process);
      if (job != IntPtr.Zero) CloseHandle(job);
      if (env != IntPtr.Zero) Marshal.FreeHGlobal(env);
    }
  }
}
`;

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
