import type { FsClient } from "isomorphic-git";
import type { KernelAsyncProgramContext } from "../../../kernel/KernelAsyncProgram.ts";
import { createNodeFs, type AsyncLeafRunner } from "../../NodeFs.ts";

export type NodeGitFsClient = FsClient & {
  readonly promises: {
    readonly lstat: (
      path: string,
      options?: { bigint?: boolean },
    ) => Promise<{ readonly isDirectory: () => boolean }>;
    readonly readdir: (path: string) => Promise<string[]>;
    readonly rm: (
      path: string,
      options?: { recursive?: boolean; force?: boolean; maxRetries?: number },
    ) => Promise<void>;
  };
};

export function createGitFs(
  context: KernelAsyncProgramContext,
  cloneDir?: string,
): NodeGitFsClient {
  let cloneCleanupDepth = 0;
  const runLeaf: AsyncLeafRunner = async (operation, signal) => {
    if (cloneCleanupDepth === 0) context.signal.throwIfAborted();
    signal?.throwIfAborted();
    return operation();
  };
  const modules = createNodeFs(context.filesystem, undefined, runLeaf);
  const facade = modules["fs/promises"];
  const { chmod: _unsupportedChmod, default: _default, ...promises } = facade;
  const gitPromises = {
    ...promises,
    rm: async (path: string, options?: { recursive?: boolean; force?: boolean }) => {
      if (
        cloneDir !== undefined &&
        context.signal.aborted &&
        cloneCleanupDepth === 0 &&
        options?.recursive === true &&
        isCloneGitDirectory(context, path, cloneDir)
      ) {
        cloneCleanupDepth += 1;
        try {
          await facade.rm(path, options);
        } finally {
          cloneCleanupDepth -= 1;
        }
        return;
      }
      await facade.rm(path, options);
    },
    stat: async (path: string, options?: { bigint?: boolean }) =>
      withPosixMetadata(await facade.stat(path, options), context, path, true),
    lstat: async (path: string, options?: { bigint?: boolean }) =>
      withPosixMetadata(await facade.lstat(path, options), context, path, false),
  };
  // Git writes POSIX owner and mode bits into its index, so read them from this same filesystem.
  // NodeFs deliberately reports chmod as unsupported; omitting it keeps mode-aware writes real.
  return Object.freeze({ promises: Object.freeze(gitPromises) }) as NodeGitFsClient;
}

function isCloneGitDirectory(
  context: KernelAsyncProgramContext,
  path: string,
  cloneDir: string,
): boolean {
  try {
    const expected = context.filesystem.resolve(`${cloneDir}/.git`, { followFinal: false });
    const actual = context.filesystem.resolve(path, { followFinal: false });
    return (
      expected.mount === actual.mount &&
      expected.pathComponents.length === actual.pathComponents.length &&
      expected.pathComponents.every(
        (component, index) => component === actual.pathComponents[index],
      )
    );
  } catch {
    return false;
  }
}

function withPosixMetadata<T extends object>(
  stats: T,
  context: KernelAsyncProgramContext,
  path: string,
  follow: boolean,
): T {
  const metadata = context.filesystem.getPosixMetadata(path, follow);
  const current = stats as T & {
    mode: number | bigint;
    uid: number | bigint;
    gid: number | bigint;
  };
  const asBigInt = typeof current.mode === "bigint";
  const convert = (value: number) => (asBigInt ? BigInt(value) : value);
  const typeBits = Number(current.mode) & 0o170000;
  Object.defineProperties(stats, {
    mode: { value: convert(typeBits | metadata.mode) },
    uid: { value: convert(metadata.uid) },
    gid: { value: convert(metadata.gid) },
  });
  return stats;
}
