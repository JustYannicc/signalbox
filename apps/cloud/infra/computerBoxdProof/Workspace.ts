import type {
  CommitInode,
  FileHydrationPort,
  ForkCommit,
} from "../../src/kernel/FilePersistencePorts.ts";
import { isPosixMetadata, type PosixMetadata } from "../../src/kernel/PosixStorage.ts";
import type { Stat } from "../../src/kernel/storage.ts";
import type { KernelCommand } from "../../src/kernel/KernelCommandForwarder.ts";
import type {
  MachineWorkspace,
  MachineWorkspaceMount,
} from "../../src/computer/MachineWorkspace.ts";
import { prepareBoxdProofNativeWorkspace } from "./WorkspaceNative.ts";
import {
  BOXD_PROOF_MAX_FILE_BYTES,
  BOXD_PROOF_TRACKED_PATH,
  BOXD_PROOF_WORKSPACE_LABEL,
  BoxdProofWorkspaceError,
  type BoxdProofTrackedFile,
  type BoxdProofWorkspaceOptions,
} from "./WorkspaceTypes.ts";

export { BoxdProofWorkspaceError, BOXD_PROOF_WORKSPACE_LABEL };
export type {
  BoxdProofTrackedFile,
  BoxdProofVmPort,
  BoxdProofWorkspaceOptions,
} from "./WorkspaceTypes.ts";

const COMMIT_CHUNK_BYTES = 64 * 1024;

/** Supplies only the MachineWorkspace.prepare mount for the one-file boxd proof fixture. */
export function createBoxdProofWorkspace(
  options: BoxdProofWorkspaceOptions,
): MachineWorkspace["prepare"] {
  const tracked = snapshotTrackedFile(options.trackedFiles);
  return async (machine, at, hydration, signal): Promise<MachineWorkspaceMount> => {
    signal.throwIfAborted();
    const initialBytes = await hydrateTrackedFile(hydration, at, tracked, signal);
    const nativeWorkspace = await prepareBoxdProofNativeWorkspace(
      options.vm,
      machine.id,
      initialBytes,
      {
        mode: tracked.posix?.mode ?? 0o644,
        uid: tracked.posix?.uid ?? null,
        gid: tracked.posix?.gid ?? null,
        atimeNs: tracked.stat.atimeNs,
        mtimeNs: tracked.stat.mtimeNs,
      },
      signal,
    );

    const canonicalCwd = async (
      command: KernelCommand,
      generation: number,
      cwdSignal: AbortSignal,
    ): Promise<string> => {
      if (generation !== machine.generation) {
        throw new BoxdProofWorkspaceError("Runner generation does not match the prepared machine");
      }
      await nativeWorkspace.validateCwd(command.cwd, cwdSignal);
      return command.cwd;
    };

    const changes: MachineWorkspaceMount["changes"] = async (changesSignal) => {
      const nativeChange = await nativeWorkspace.readChanges(changesSignal);
      if (nativeChange === undefined) return Object.freeze([]);

      const { metadata: current, bytes: detachedBytes } = nativeChange;
      const stat: Readonly<Stat> = Object.freeze({
        type: "file",
        size: BigInt(current.size),
        nlink: BigInt(current.nlink),
        atimeNs: BigInt(current.atimeNs),
        mtimeNs: BigInt(current.mtimeNs),
        ctimeNs: BigInt(current.ctimeNs),
      });
      const posix: Readonly<PosixMetadata> = Object.freeze({
        mode: current.mode,
        uid: current.uid,
        gid: current.gid,
      });
      const paths = Object.freeze([tracked.path]);
      const removedPaths = Object.freeze([] as string[]);
      const readChunks: CommitInode["readChunks"] = async function* () {
        for (let offset = 0; offset < detachedBytes.byteLength; offset += COMMIT_CHUNK_BYTES) {
          yield detachedBytes.slice(
            offset,
            Math.min(offset + COMMIT_CHUNK_BYTES, detachedBytes.length),
          );
        }
      };
      const change: CommitInode = Object.freeze({
        inode: tracked.inode,
        paths,
        removedPaths,
        stat,
        symlinkTarget: null,
        posix,
        readChunks,
      });
      return Object.freeze([change]);
    };

    return Object.freeze({ canonicalCwd, changes });
  };
}

function snapshotTrackedFile(files: readonly BoxdProofTrackedFile[]): BoxdProofTrackedFile {
  if (files.length !== 1 || files[0]?.path !== BOXD_PROOF_TRACKED_PATH) {
    throw new BoxdProofWorkspaceError(
      `${BOXD_PROOF_WORKSPACE_LABEL} does not accept another manifest shape`,
    );
  }
  const file = files[0];
  if (file.inode <= 0n || file.stat.type !== "file" || file.stat.size < 0n) {
    throw new BoxdProofWorkspaceError("The proof manifest must identify one regular kernel file");
  }
  if (file.stat.size > BigInt(BOXD_PROOF_MAX_FILE_BYTES)) {
    throw new BoxdProofWorkspaceError("The proof file exceeds the 16 MiB fixture limit");
  }
  if (file.posix != null && !isPosixMetadata(file.posix)) {
    throw new BoxdProofWorkspaceError("The proof manifest contains invalid POSIX metadata");
  }
  return Object.freeze({
    path: file.path,
    inode: file.inode,
    stat: Object.freeze({ ...file.stat }),
    posix: file.posix == null ? null : Object.freeze({ ...file.posix }),
  });
}

async function hydrateTrackedFile(
  hydration: FileHydrationPort,
  at: ForkCommit,
  tracked: BoxdProofTrackedFile,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const result = await hydration.fetch({ at, paths: [tracked.path], signal });
  if (result.status === "error") {
    throw new BoxdProofWorkspaceError(
      `Proof hydration failed (${result.error.code}): ${result.error.message}`,
    );
  }
  if (result.value.length !== 1 || result.value[0]?.path !== tracked.path) {
    throw new BoxdProofWorkspaceError("Hydration did not return exactly the tracked proof file");
  }
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of result.value[0].chunks) {
    signal.throwIfAborted();
    if (!(chunk instanceof Uint8Array)) {
      throw new BoxdProofWorkspaceError("Hydration returned a non-byte chunk");
    }
    const copy = chunk.slice();
    size += copy.byteLength;
    if (size > BOXD_PROOF_MAX_FILE_BYTES) {
      throw new BoxdProofWorkspaceError("Hydrated proof file exceeds the 16 MiB fixture limit");
    }
    parts.push(copy);
  }
  if (BigInt(size) !== tracked.stat.size) {
    throw new BoxdProofWorkspaceError("Hydrated bytes do not match the tracked kernel file size");
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}
