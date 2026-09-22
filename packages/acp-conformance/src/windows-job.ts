import koffi from "koffi";

export function createWindowsJob(): void {
  const basic = koffi.struct({
    ProcessTime: "int64_t", JobTime: "int64_t", Flags: "uint32_t",
    MinWorkingSet: "size_t", MaxWorkingSet: "size_t", ActiveProcesses: "uint32_t",
    Affinity: "uintptr_t", Priority: "uint32_t", Scheduling: "uint32_t",
  });
  const io = koffi.struct({
    ReadOperations: "uint64_t", WriteOperations: "uint64_t", OtherOperations: "uint64_t",
    ReadBytes: "uint64_t", WriteBytes: "uint64_t", OtherBytes: "uint64_t",
  });
  const extended = koffi.struct({
    Basic: basic, Io: io, ProcessMemory: "size_t", JobMemory: "size_t",
    PeakProcessMemory: "size_t", PeakJobMemory: "size_t",
  });
  const kernel = koffi.load("kernel32.dll");
  const createJob = kernel.func("void * __stdcall CreateJobObjectW(void *attributes, void *name)");
  const setLimits = kernel.func("int __stdcall SetInformationJobObject(void *job, int kind, void *limits, uint32_t size)");
  const assign = kernel.func("int __stdcall AssignProcessToJobObject(void *job, void *process)");
  const currentProcess = kernel.func("void * __stdcall GetCurrentProcess()");
  const close = kernel.func("int __stdcall CloseHandle(void *handle)");
  const job = createJob(null, null);
  if (!job) throw new Error("Job creation failed.");
  const limits = Buffer.alloc(koffi.sizeof(extended));
  limits.writeUInt32LE(0x2000, koffi.offsetof(extended, "Basic") + koffi.offsetof(basic, "Flags"));
  if (!setLimits(job, 9, limits, limits.length)) {
    close(job);
    throw new Error("Job limits failed.");
  }
  if (!assign(job, currentProcess())) {
    close(job);
    throw new Error("Job assignment failed.");
  }
  // The OS closes this non-inheritable handle when the owner exits, killing all job members.
}
