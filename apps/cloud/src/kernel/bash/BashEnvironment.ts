import type { KernelBashCredentials } from "./BashContext.ts";
import type { KernelFileSystem } from "../KernelFileSystem.ts";
import { range, errno } from "./BashMemory.ts";

export function createBashEnvironment(options: {
  readonly memory: () => WebAssembly.Memory;
  readonly credentials: KernelBashCredentials;
  readonly pid: () => number;
  readonly filesystem?: KernelFileSystem;
}) {
  const { credentials } = options;
  assertBashPosixCredentials(credentials, options.filesystem);
  const initialPolicy = options.filesystem?.posixPolicy;
  if (initialPolicy !== undefined) credentials.umask = initialPolicy.umask;
  let loaderError = false;
  let loaderErrorPointer: number | undefined;
  return {
    getpid: options.pid,
    getuid: () => credentials.uid,
    getgid: () => credentials.gid,
    geteuid: () => credentials.euid,
    getegid: () => credentials.egid,
    // A differing effective ID would make this a privilege change, which the kernel cannot apply.
    setuid: (uid: number) =>
      uid >>> 0 === credentials.uid && credentials.uid === credentials.euid ? 0 : -63,
    setgid: (gid: number) =>
      gid >>> 0 === credentials.gid && credentials.gid === credentials.egid ? 0 : -63,
    umask: (mask: number) => {
      try {
        const next = mask & 0o777;
        const filesystem = options.filesystem;
        const previous =
          filesystem !== undefined && filesystem.posixPolicy !== undefined
            ? filesystem.setUmask(next)
            : credentials.umask;
        credentials.umask = next;
        return previous;
      } catch (error) {
        return -errno(error);
      }
    },
    gethostname: (pointer: number, capacity: number) => {
      try {
        const bytes = new TextEncoder().encode(credentials.hostname);
        if (capacity >>> 0 <= bytes.length) return -37;
        const target = range(options.memory(), pointer, bytes.length + 1);
        target.set(bytes);
        target[bytes.length] = 0;
        return 0;
      } catch (error) {
        return -errno(error);
      }
    },
    dlopen: (_path: number, _flags: number) => {
      loaderError = true;
      return 0;
    },
    dlsym: (_handle: number, _name: number) => {
      loaderError = true;
      return 0;
    },
    dlclose: (_handle: number) => {
      loaderError = true;
      return -1;
    },
    dlerror: () => {
      if (!loaderError) return 0;
      loaderError = false;
      if (loaderErrorPointer === undefined) {
        const memory = options.memory();
        loaderErrorPointer = memory.buffer.byteLength;
        memory.grow(1);
        range(memory, loaderErrorPointer, 52).set(
          new TextEncoder().encode("Dynamic loading is unavailable for static GNU Bash.\0"),
        );
      }
      return loaderErrorPointer;
    },
  };
}

/** A guest may report only the identity already bound to its filesystem policy. */
export function assertBashPosixCredentials(
  credentials: Pick<KernelBashCredentials, "uid" | "gid" | "euid" | "egid">,
  filesystem?: KernelFileSystem,
): void {
  const actual = filesystem?.posixCredentials;
  if (actual === undefined) return;
  if (
    actual.uid !== credentials.uid ||
    actual.gid !== credentials.gid ||
    actual.euid !== credentials.euid ||
    actual.egid !== credentials.egid
  ) {
    throw Object.assign(new Error("GNU Bash credentials do not match its filesystem policy"), {
      code: "EINVAL",
    });
  }
}
