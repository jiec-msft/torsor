import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

// An external guardian keeps the job handle alive until the owner's stdin pipe closes.
export function createWindowsJob(): Promise<ChildProcessWithoutNullStreams> {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OwnedJob {
  [StructLayout(LayoutKind.Sequential)]
  public struct BasicLimits {
    public long ProcessTime, JobTime;
    public uint Flags;
    public UIntPtr MinWorkingSet, MaxWorkingSet;
    public uint ActiveProcesses;
    public UIntPtr Affinity;
    public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct IoCounters {
    public ulong ReadOperations, WriteOperations, OtherOperations;
    public ulong ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct ExtendedLimits {
    public BasicLimits Basic;
    public IoCounters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint size);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")]
  public static extern bool CloseHandle(IntPtr handle);
  public static IntPtr Create(int ownerPid) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Exception("Job creation failed");
    var limits = new ExtendedLimits();
    limits.Basic.Flags = 0x2000;
    if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits))) {
      CloseHandle(job); throw new Exception("Job limits failed");
    }
    IntPtr owner = OpenProcess(0x0101, false, ownerPid);
    if (owner == IntPtr.Zero) { CloseHandle(job); throw new Exception("Owner handle failed"); }
    bool assigned = AssignProcessToJobObject(job, owner);
    CloseHandle(owner);
    if (!assigned) { CloseHandle(job); throw new Exception("Job assignment failed"); }
    return job;
  }
}
'@
$job = [OwnedJob]::Create(${process.pid})
try {
  [Console]::Out.WriteLine('ready')
  [Console]::Out.Flush()
  $null = [Console]::In.ReadLine()
} finally {
  $null = [OwnedJob]::CloseHandle($job)
}
`;
  return new Promise((resolve, reject) => {
    const guardian = spawn("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive",
      "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64"),
    ], { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    let errorBytes = 0;
    let ready = false;
    guardian.stdout.on("data", (chunk: Buffer) => {
      if (ready) return;
      if (output.length + chunk.length > 32) {
        reject(new Error("Invalid job guardian response."));
        return;
      }
      output += chunk.toString("ascii");
      if (output.trim() === "ready" && !ready) { ready = true; resolve(guardian); }
    });
    guardian.stderr.on("data", (chunk: Buffer) => {
      errorBytes += chunk.length;
      if (errorBytes > 16384) reject(new Error("Job guardian exceeded its output budget."));
    });
    guardian.once("error", () => reject(new Error("Could not start job guardian.")));
    guardian.once("exit", () => {
      if (!ready) reject(new Error("Job guardian exited before readiness."));
    });
  });
}
