import { KernelOpenFlags } from "../../src/kernel/KernelFileSystem.ts";

export const proofCredentials = Object.freeze({
  uid: 1000,
  gid: 1000,
  euid: 1000,
  egid: 1000,
  groups: [],
});

export const proofEnvironment = Object.freeze({
  HOME: "/home/codex",
  PWD: "/workspace",
  PATH: "/bin",
  SHELL: "/bin/bash",
  CODEX_EXEC_SERVER_URL: "ws://localhost/exec",
  OPENAI_API_KEY: "mock-only",
});

export function initializeProofRoot(storage) {
  try {
    storage.posix.get(storage.root);
  } catch (error) {
    if (error.code !== "ENOTSUP") throw error;
    storage.posix.initialize(storage.root, { mode: 0o755, uid: 1000, gid: 1000 });
  }
}

export function initializeProofDirectories(filesystem) {
  for (const path of ["/workspace", "/home", "/home/codex", "/bin", "/tmp"]) {
    try {
      filesystem.mkdir(path, 0o755);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (filesystem.stat(path).type !== "directory") throw error;
    }
  }
  filesystem.chdir("/workspace");
}

export function verifyPatchResult(filesystem) {
  const expected = new TextEncoder().encode("codex-patch-proof\n");
  const fd = filesystem.open("/workspace/proof.txt", KernelOpenFlags.O_RDONLY);
  try {
    const stat = filesystem.fstat(fd);
    if (stat.type !== "file" || stat.size !== BigInt(expected.length)) {
      throw new Error("Patch result has the wrong file size or type");
    }
    const actual = new Uint8Array(expected.length);
    let offset = 0;
    while (offset < actual.length) {
      const count = filesystem.read(fd, actual.subarray(offset), null);
      if (count === 0) throw new Error("Patch result ended early");
      offset += count;
    }
    if (!actual.every((byte, index) => byte === expected[index])) {
      throw new Error("Patch result does not match the requested contents");
    }
    return new TextDecoder().decode(actual);
  } finally {
    filesystem.close(fd);
  }
}

export function proofInput(pipe) {
  return {
    supportsNonblocking: true,
    readInto: (bytes, flags) => (flags & 4 ? pipe.tryReadInto(bytes) : pipe.readInto(bytes)),
    poll: (direction, signal) =>
      new Promise((resolve, reject) => {
        let unsubscribe = () => {};
        const abort = () => {
          unsubscribe();
          reject(signal.reason);
        };
        const done = () => {
          unsubscribe();
          signal.removeEventListener("abort", abort);
          resolve({ bytes: BigInt(pipe.bufferedBytes) });
        };
        unsubscribe = pipe.subscribe(direction)(done);
        if (signal.aborted) abort();
        else if (pipe.ready(direction)) done();
        else signal.addEventListener("abort", abort, { once: true });
      }),
  };
}
