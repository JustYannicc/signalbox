// @effect-diagnostics nodeBuiltinImport:off - executable verification hashes bounded chunks.
import { canReplaceKernelFile } from "./KernelFileReplacement.ts";
import * as NodeCrypto from "node:crypto";
import { KernelOpenFlags, type KernelFileSystem } from "./KernelFileSystem.ts";

export interface KernelExecutableArtifact {
  readonly bytes: number;
  readonly sha256: string;
}

export interface KernelExecutableNamespace {
  readonly canReplace?: (path: string) => Promise<boolean>;
  readonly inspect: (
    path: string,
    artifact?: KernelExecutableArtifact,
  ) => Promise<{
    readonly type: string;
    readonly lower: boolean;
    readonly matchesArtifact: boolean;
  }>;
}

export interface KernelExecutableNamespaceOwner extends KernelExecutableNamespace {
  readonly close: () => Promise<void>;
}

interface NamespaceOptions {
  readonly filesystem: KernelFileSystem;
  readonly signal: AbortSignal;
  readonly overlay?: {
    readonly prepare: (paths: readonly string[], signal?: AbortSignal) => Promise<void>;
    readonly isLower: (path: string, signal?: AbortSignal) => Promise<boolean>;
  };
}

/** Borrows the requesting process's namespace; inspection never creates another filesystem. */
export function createKernelExecutableNamespace(
  options: NamespaceOptions,
): KernelExecutableNamespaceOwner {
  let state: NamespaceOptions | undefined = {
    filesystem: options.filesystem,
    signal: options.signal,
    ...(options.overlay === undefined ? {} : { overlay: options.overlay }),
  };
  const controller = new AbortController();
  const active = new Set<Promise<unknown>>();
  return {
    async canReplace(path: string) {
      if (state === undefined)
        throw Object.assign(new Error("Executable namespace is closed"), { code: "EBADF" });
      state.signal.throwIfAborted();
      return canReplaceKernelFile(state.filesystem, path);
    },
    async inspect(path, artifact) {
      if (state === undefined)
        throw Object.assign(new Error("Executable namespace is closed"), { code: "EBADF" });
      const pending = inspectNamespace(
        state,
        AbortSignal.any([state.signal, controller.signal]),
        path,
        artifact,
      );
      active.add(pending);
      try {
        return await pending;
      } finally {
        active.delete(pending);
      }
    },
    async close() {
      state = undefined;
      controller.abort(new Error("Executable namespace owner closed"));
      await Promise.allSettled(active);
    },
  };
}

async function inspectNamespace(
  { filesystem, overlay }: NamespaceOptions,
  signal: AbortSignal,
  path: string,
  artifact: KernelExecutableArtifact | undefined,
) {
  signal.throwIfAborted();
  await overlay?.prepare([path], signal);
  const lower = (await overlay?.isLower(path, signal)) ?? false;
  const stat = await filesystem.checkExecutable(path, signal);
  const matchesArtifact =
    !lower && stat.type === "file" && artifact !== undefined
      ? await matchesExecutable(filesystem, path, artifact, signal)
      : false;
  signal.throwIfAborted();
  return { type: stat.type, lower, matchesArtifact };
}

async function matchesExecutable(
  filesystem: KernelFileSystem,
  path: string,
  artifact: KernelExecutableArtifact,
  signal: AbortSignal,
) {
  if (
    !Number.isSafeInteger(artifact.bytes) ||
    artifact.bytes < 0 ||
    !/^[a-f0-9]{64}$/u.test(artifact.sha256)
  )
    throw new TypeError("Invalid executable artifact identity");
  const fd = await filesystem.openAsync(path, KernelOpenFlags.O_RDONLY, undefined, signal);
  try {
    if (filesystem.fstat(fd).size !== BigInt(artifact.bytes)) return false;
    const hash = NodeCrypto.createHash("sha256");
    const chunk = new Uint8Array(64 * 1024);
    let position = 0;
    while (position < artifact.bytes) {
      const read = await filesystem.readAsync(
        fd,
        chunk.subarray(0, Math.min(chunk.length, artifact.bytes - position)),
        BigInt(position),
        signal,
      );
      if (read === 0) return false;
      hash.update(chunk.subarray(0, read));
      position += read;
    }
    signal.throwIfAborted();
    return hash.digest("hex") === artifact.sha256;
  } finally {
    filesystem.close(fd);
  }
}
