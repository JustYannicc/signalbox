import type { KernelBashCredentials } from "./BashContext.ts";
import { range, errno } from "./BashMemory.ts";

export function createBashEnvironment(options: {
  readonly memory: () => WebAssembly.Memory;
  readonly credentials: KernelBashCredentials;
  readonly pid: () => number;
}) {
  const { credentials } = options;
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
      const previous = credentials.umask;
      credentials.umask = mask & 0o777;
      return previous;
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
