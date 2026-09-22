import { toNamespacedPath } from "node:path";
import koffi from "koffi";

export interface FileIdentity { dev: string; ino: string }
export interface PublicationPrimitives {
  lock(path: string, fd: number, identity: FileIdentity): (() => void) | undefined;
  publish(source: string, destination: string): void;
}
export class NativeArtifactError extends Error {}

const collision = () => new NativeArtifactError("Artifact destination already exists; no files were overwritten.");

export function publicationPrimitives(): PublicationPrimitives {
  if (process.platform === "linux") {
    const libc = koffi.load(null);
    const flock = libc.func("int flock(int fd, int operation)");
    const rename = libc.func("int renameat2(int olddirfd, str oldpath, int newdirfd, str newpath, unsigned int flags)");
    return {
      lock(_path, fd) {
        if (flock(fd, 2 | 4) !== 0) {
          if (koffi.errno() === koffi.os.errno.EWOULDBLOCK) return undefined;
          throw new NativeArtifactError("Could not lock artifact claim.");
        }
        return () => {
          if (flock(fd, 8) !== 0) throw new NativeArtifactError("Could not release artifact claim.");
        };
      },
      publish(source, destination) {
        if (rename(-100, source, -100, destination, 1) === 0) return;
        if (koffi.errno() === koffi.os.errno.EEXIST) throw collision();
        throw new NativeArtifactError("Atomic no-replace artifact publication failed; filesystem support is required.");
      },
    };
  }
  if (process.platform !== "win32") {
    throw new NativeArtifactError("Artifact publication requires Windows or Linux no-replace filesystem primitives.");
  }
  const kernel = koffi.load("kernel32.dll");
  const create = kernel.func("intptr_t __stdcall CreateFileW(str16 path, uint32_t access, uint32_t share, void *security, uint32_t creation, uint32_t flags, intptr_t template)");
  const close = kernel.func("int __stdcall CloseHandle(intptr_t handle)");
  const lastError = kernel.func("uint32_t __stdcall GetLastError()");
  const info = kernel.func("int __stdcall GetFileInformationByHandle(intptr_t handle, void *information)");
  const lock = kernel.func("int __stdcall LockFileEx(intptr_t handle, uint32_t flags, uint32_t reserved, uint32_t low, uint32_t high, void *overlapped)");
  const move = kernel.func("int __stdcall MoveFileExW(str16 source, str16 destination, uint32_t flags)");
  const fileTime = koffi.array("uint32_t", 2);
  const fileInfo = koffi.struct({
    Attributes: "uint32_t", CreationTime: fileTime, AccessTime: fileTime, WriteTime: fileTime,
    Volume: "uint32_t", SizeHigh: "uint32_t", SizeLow: "uint32_t", Links: "uint32_t",
    IndexHigh: "uint32_t", IndexLow: "uint32_t",
  });
  const overlapped = koffi.struct({
    Internal: "uintptr_t", InternalHigh: "uintptr_t", Offset: "uint32_t", OffsetHigh: "uint32_t", Event: "uintptr_t",
  });
  return {
    lock(path, _fd, identity) {
      // A native handle avoids assumptions about Node's private CRT descriptor table.
      const handle = create(toNamespacedPath(path), 0xc0000000, 7, null, 3, 0x00200000, 0);
      if (handle === -1 || handle === -1n) {
        if ([2, 3, 303].includes(lastError())) return undefined;
        throw new NativeArtifactError("Could not open artifact claim lock.");
      }
      const release = () => {
        if (!close(handle)) throw new NativeArtifactError("Could not close artifact claim lock.");
      };
      let held = false;
      try {
        const data = Buffer.alloc(koffi.sizeof(fileInfo));
        if (!info(handle, data)) throw new NativeArtifactError("Could not identify artifact claim lock.");
        const word = (key: string) => data.readUInt32LE(koffi.offsetof(fileInfo, key));
        const ino = (BigInt(word("IndexHigh")) << 32n) | BigInt(word("IndexLow"));
        if ((word("Attributes") & (0x400 | 0x10)) !== 0 || word("Volume").toString() !== identity.dev || ino.toString() !== identity.ino) {
          throw new NativeArtifactError("Artifact claim lock identity changed.");
        }
        // Lock beyond the bounded journal so its separate Node handle can read/write on Windows.
        const range = Buffer.alloc(koffi.sizeof(overlapped));
        range.writeUInt32LE(0x7fffffff, koffi.offsetof(overlapped, "Offset"));
        if (!lock(handle, 1 | 2, 0, 1, 0, range)) {
          if (lastError() === 33) return undefined;
          throw new NativeArtifactError("Could not lock artifact claim.");
        }
        held = true;
        return release;
      } finally { if (!held) release(); }
    },
    publish(source, destination) {
      if (move(toNamespacedPath(source), toNamespacedPath(destination), 8)) return;
      const error = lastError();
      if (error === 80 || error === 183) throw collision();
      throw new NativeArtifactError("Atomic no-replace artifact publication failed; filesystem support is required.");
    },
  };
}
