import { readSync, writeSync } from "node:fs";

import koffi from "koffi";

const MAX_FIELD_BYTES = 1024 * 1024;
const CREATE_SUSPENDED = 0x00000004;
const CREATE_UNICODE_ENVIRONMENT = 0x00000400;
const CREATE_NO_WINDOW = 0x08000000;
const HANDLE_FLAG_INHERIT = 0x00000001;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
const JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION = 1;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
const WAIT_OBJECT_0 = 0;
const WAIT_TIMEOUT = 0x102;

interface NativeProcessInformation {
  readonly Process: unknown;
  readonly Thread: unknown;
  readonly ProcessId: number;
  readonly ThreadId: number;
}

interface NativeAccounting {
  readonly ActiveProcesses: number;
}

const basicLimits = koffi.struct("TorsorBasicLimits", {
  ProcessTime: "int64_t",
  JobTime: "int64_t",
  Flags: "uint32_t",
  MinWorkingSet: "size_t",
  MaxWorkingSet: "size_t",
  ActiveProcesses: "uint32_t",
  Affinity: "uintptr_t",
  Priority: "uint32_t",
  Scheduling: "uint32_t",
});
const ioCounters = koffi.struct("TorsorIoCounters", {
  ReadOperations: "uint64_t",
  WriteOperations: "uint64_t",
  OtherOperations: "uint64_t",
  ReadBytes: "uint64_t",
  WriteBytes: "uint64_t",
  OtherBytes: "uint64_t",
});
const extendedLimits = koffi.struct("TorsorExtendedLimits", {
  Basic: basicLimits,
  Io: ioCounters,
  ProcessMemory: "size_t",
  JobMemory: "size_t",
  PeakProcessMemory: "size_t",
  PeakJobMemory: "size_t",
});
const startupInfo = koffi.struct("TorsorStartupInfoW", {
  Size: "uint32_t",
  Reserved: "void *",
  Desktop: "void *",
  Title: "void *",
  X: "uint32_t",
  Y: "uint32_t",
  Width: "uint32_t",
  Height: "uint32_t",
  CharacterWidth: "uint32_t",
  CharacterHeight: "uint32_t",
  FillAttribute: "uint32_t",
  Flags: "uint32_t",
  ShowWindow: "uint16_t",
  ReservedBytes: "uint16_t",
  ReservedPointer: "void *",
  Input: "void *",
  Output: "void *",
  Error: "void *",
});
const processInformation = koffi.struct("TorsorProcessInformation", {
  Process: "void *",
  Thread: "void *",
  ProcessId: "uint32_t",
  ThreadId: "uint32_t",
});
const accountingInformation = koffi.struct("TorsorAccountingInformation", {
  TotalUserTime: "int64_t",
  TotalKernelTime: "int64_t",
  PeriodUserTime: "int64_t",
  PeriodKernelTime: "int64_t",
  PageFaultCount: "uint32_t",
  TotalProcesses: "uint32_t",
  ActiveProcesses: "uint32_t",
  TerminatedProcesses: "uint32_t",
});

const kernel = koffi.load("kernel32.dll");
const createProcess = kernel.func("__stdcall", "CreateProcessW", "int", [
  "void *", "void *", "void *", "void *", "int", "uint32_t", "void *", "void *",
  koffi.inout(koffi.pointer(startupInfo)),
  koffi.out(koffi.pointer(processInformation)),
]);
const createJob = kernel.func(
  "__stdcall", "CreateJobObjectW", "void *", ["void *", "void *"],
);
const setJobInformation = kernel.func(
  "__stdcall", "SetInformationJobObject", "int",
  ["void *", "int", "void *", "uint32_t"],
);
const queryJobInformation = kernel.func(
  "__stdcall", "QueryInformationJobObject", "int",
  ["void *", "int", koffi.out(koffi.pointer(accountingInformation)), "uint32_t", "void *"],
);
const assignProcess = kernel.func(
  "__stdcall", "AssignProcessToJobObject", "int", ["void *", "void *"],
);
const terminateJob = kernel.func(
  "__stdcall", "TerminateJobObject", "int", ["void *", "uint32_t"],
);
const terminateProcess = kernel.func(
  "__stdcall", "TerminateProcess", "int", ["void *", "uint32_t"],
);
const resumeThread = kernel.func(
  "__stdcall", "ResumeThread", "uint32_t", ["void *"],
);
const waitForSingleObject = kernel.func(
  "__stdcall", "WaitForSingleObject", "uint32_t", ["void *", "uint32_t"],
);
const getExitCode = kernel.func(
  "__stdcall", "GetExitCodeProcess", "int", ["void *", koffi.out(koffi.pointer("uint32_t"))],
);
const getStdHandle = kernel.func(
  "__stdcall", "GetStdHandle", "void *", ["int32_t"],
);
const setHandleInformation = kernel.func(
  "__stdcall", "SetHandleInformation", "int", ["void *", "uint32_t", "uint32_t"],
);
const closeHandle = kernel.func(
  "__stdcall", "CloseHandle", "int", ["void *"],
);

function readField(): Buffer {
  const header = readExact(4);
  const length = header.readInt32LE();
  if (length < 0 || length > MAX_FIELD_BYTES) throw new Error("Invalid owner field length.");
  return readExact(length);
}

function readExact(length: number): Buffer {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const count = readSync(0, buffer, offset, length - offset, null);
    if (count === 0) throw new Error("Unexpected owner input end.");
    offset += count;
  }
  return buffer;
}

function terminatedUtf16(value: Buffer): Buffer {
  const terminated = Buffer.alloc(value.length + 2);
  value.copy(terminated);
  return terminated;
}

function requiredHandle(value: unknown): unknown {
  if (value === null || value === undefined) throw new Error("Required native handle is missing.");
  return value;
}

function processInfo(value: unknown): NativeProcessInformation {
  if (!value || typeof value !== "object") throw new Error("Process information is invalid.");
  const record = value as Partial<NativeProcessInformation>;
  return {
    Process: requiredHandle(record.Process),
    Thread: requiredHandle(record.Thread),
    ProcessId: Number(record.ProcessId),
    ThreadId: Number(record.ThreadId),
  };
}

function activeProcessCount(value: unknown): number {
  if (!value || typeof value !== "object") throw new Error("Job accounting is invalid.");
  const active = Number((value as Partial<NativeAccounting>).ActiveProcesses);
  if (!Number.isSafeInteger(active) || active < 0) throw new Error("Job accounting is invalid.");
  return active;
}

async function run(): Promise<number> {
  const applicationName = terminatedUtf16(readField());
  const commandLine = terminatedUtf16(readField());
  const marker = readField().toString("utf16le");
  const exitMarker = readField().toString("utf16le");
  const environment = terminatedUtf16(readField());
  const directory = terminatedUtf16(readField());
  const job = createJob(null, null);
  if (!job) return 121;
  let process: NativeProcessInformation | undefined;
  let assigned = false;
  try {
    const limits = Buffer.alloc(koffi.sizeof(extendedLimits));
    limits.writeUInt32LE(
      JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
      koffi.offsetof(extendedLimits, "Basic") + koffi.offsetof(basicLimits, "Flags"),
    );
    if (!setJobInformation(
      job,
      JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
      limits,
      limits.length,
    )) return 122;
    const input = getStdHandle(-10);
    const output = getStdHandle(-11);
    const error = getStdHandle(-12);
    for (const handle of [input, output, error]) {
      if (!handle || !setHandleInformation(
        handle,
        HANDLE_FLAG_INHERIT,
        HANDLE_FLAG_INHERIT,
      )) return 123;
    }
    const startup = {
      Size: koffi.sizeof(startupInfo),
      Reserved: null,
      Desktop: null,
      Title: null,
      X: 0,
      Y: 0,
      Width: 0,
      Height: 0,
      CharacterWidth: 0,
      CharacterHeight: 0,
      FillAttribute: 0,
      Flags: 0x00000100,
      ShowWindow: 0,
      ReservedBytes: 0,
      ReservedPointer: null,
      Input: input,
      Output: output,
      Error: error,
    };
    const created: Record<string, unknown> = {};
    if (!createProcess(
      applicationName,
      commandLine,
      null,
      null,
      1,
      CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED,
      environment,
      directory,
      startup,
      created,
    )) return 124;
    process = processInfo(created);
    if (!assignProcess(job, process.Process)) return 126;
    assigned = true;
    if (resumeThread(process.Thread) === 0xffffffff) return 127;
    let forceStopRequested = false;
    globalThis.process.on("message", (message: unknown) => {
      if (message && typeof message === "object" && "type" in message &&
          message.type === "force-stop") forceStopRequested = true;
    });
    let forced = false;
    while (true) {
      const wait = waitForSingleObject(process.Process, 25);
      if (wait === WAIT_OBJECT_0) break;
      if (wait !== WAIT_TIMEOUT) return 125;
      if (forceStopRequested) {
        if (!terminateJob(job, 137) ||
            waitForSingleObject(process.Process, 1_000) !== WAIT_OBJECT_0) return 125;
        forced = true;
        break;
      }
      // Yield so the private IPC stop request can be handled while the Provider is running.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const exitCode: number[] = [0];
    if (!getExitCode(process.Process, exitCode)) return 125;
    writeSync(2, `${exitMarker}${Number(exitCode[0])}\n`);
    if (!forced && !terminateJob(job, 137)) return 125;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const accounting: Record<string, unknown> = {};
      if (!queryJobInformation(
        job,
        JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION,
        accounting,
        koffi.sizeof(accountingInformation),
        null,
      )) return 125;
      if (activeProcessCount(accounting) === 0) {
        writeSync(2, `${marker}${Number(exitCode[0])}\n`);
        return 0;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    return 125;
  } finally {
    if (process && !assigned) {
      terminateProcess(process.Process, 137);
      waitForSingleObject(process.Process, 1_000);
    }
    if (process) {
      closeHandle(process.Thread);
      closeHandle(process.Process);
    }
    closeHandle(job);
    applicationName.fill(0);
    commandLine.fill(0);
    environment.fill(0);
    directory.fill(0);
  }
}

void run().then(
  (code) => { process.exit(code); },
  () => { process.exit(125); },
);
