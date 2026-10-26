import { MACHINE_FILES_MAX_CONTENT_BYTES } from "@signalbox/runner-protocol/MachineFilesProtocol";
import type {
  KernelLowerFileSystemEntry,
  KernelLowerFileSystemSource,
} from "../kernel/KernelLowerFileSystem.ts";
import { machineFileMetadata } from "./MachineFileMetadata.ts";
import type { MachineFilesPort } from "./MachineFilesPort.ts";
import { indexMachinePrograms, type MachineProgramInventory } from "./MachineProgramInventory.ts";
import { liveSymlinkParents } from "./machineFiles/LiveSymlinkParents.ts";
import { machineFileRequest } from "./machineFiles/MachineFileRequest.ts";
import { createMachineImageContentReader } from "./MachineImageContent.ts";

export interface ComputerMachineFileSystemOptions {
  readonly inventory: MachineProgramInventory;
  readonly files: MachineFilesPort;
  readonly signal: AbortSignal;
}

/** Use the immutable image before a generation exists and while its attestation remains pristine. */
export function createComputerMachineFileSystem(
  options: ComputerMachineFileSystemOptions,
): KernelLowerFileSystemSource {
  const inventory = indexMachinePrograms(options.inventory);
  const imageContent = createMachineImageContentReader(options.inventory);
  const contentIsAuthoritative = (path: string) => {
    const state = options.files.current();
    return (
      imageIsAuthoritative(path) && (state.generation !== null || state.generationAbsent === true)
    );
  };
  const imageIsAuthoritative = (path: string) => {
    const state = options.files.current();
    const imageMatches =
      state.imageDigest === undefined || state.imageDigest === options.inventory.imageDigest;
    const noGeneration = state.generation === null && imageMatches;
    const pristineGeneration =
      state.pristine && state.imageDigest === options.inventory.imageDigest;
    return (noGeneration || pristineGeneration) && !inventory.isExcluded(path);
  };
  const runtimePathIsAbsent = (path: string, signal?: AbortSignal) => {
    options.signal.throwIfAborted();
    signal?.throwIfAborted();
    const state = options.files.current();
    return (
      state.generation === null && state.generationAbsent === true && inventory.isExcluded(path)
    );
  };
  const liveParents = (request: ReturnType<typeof machineFileRequest>) =>
    liveSymlinkParents({
      unavailable: request.unavailable,
      async lstat(path) {
        const result = await request.single({ id: "parent", op: "lstat", path });
        if ("error" in result) {
          if (absent(result.error.code))
            throw request.unavailable("Machine symlink parent disappeared during lookup");
          throw posixError(result.error);
        }
        if (result.op !== "lstat")
          throw request.unavailable("Machine returned the wrong ancestor operation");
        return result.stat;
      },
      async readlink(path) {
        try {
          return await request.readlink(path);
        } catch (error) {
          if (error instanceof Error && "code" in error && absent(String(error.code)))
            throw request.unavailable("Machine ancestor symlink disappeared during lookup", {
              cause: error,
            });
          throw error;
        }
      },
    });
  return {
    lookupKnown(paths) {
      options.signal.throwIfAborted();
      if (paths.some((path) => !imageIsAuthoritative(path) && !runtimePathIsAbsent(path)))
        return undefined;
      return inventory
        .lookup(paths)
        .map((entry, index) =>
          entry === undefined ? undefined : machineFileMetadata(paths[index]!, entry),
        );
    },
    readdirKnown(path) {
      options.signal.throwIfAborted();
      if (!imageIsAuthoritative(path)) return undefined;
      return inventory.readdir(path)?.map((entry) => machineFileMetadata(entry.path, entry));
    },
    readlinkKnown(path) {
      options.signal.throwIfAborted();
      if (!imageIsAuthoritative(path)) return undefined;
      return inventory.readlink(path);
    },
    async lookup(paths, signal) {
      const request = machineFileRequest(options.files, options.signal, signal);
      const parent = liveParents(request);
      const captured = paths.map((path) => ({
        path,
        image: imageIsAuthoritative(path) || runtimePathIsAbsent(path),
      }));
      const imagePaths = captured.filter((entry) => entry.image).map((entry) => entry.path);
      const image = imagePaths.length === 0 ? [] : inventory.lookup(imagePaths);
      const live = captured.filter((entry) => !entry.image);
      const results = await request.batch(
        live.map(({ path }, index) => ({ id: String(index), op: "lstat", path })),
      );
      let imageIndex = 0;
      let liveIndex = 0;
      const entries: (KernelLowerFileSystemEntry | undefined)[] = [];
      for (const { path, image: useImage } of captured) {
        if (useImage) {
          const entry = image[imageIndex++];
          entries.push(entry === undefined ? undefined : machineFileMetadata(path, entry));
          continue;
        }
        const result = results[liveIndex++];
        if (result === undefined) throw request.unavailable("Machine file response is incomplete");
        if ("error" in result) {
          if (absent(result.error.code)) {
            entries.push(undefined);
            continue;
          }
          throw posixError(result.error);
        }
        if (result.op !== "lstat")
          throw request.unavailable("Machine returned the wrong file operation");
        const symlinkParent = result.stat.type === "symlink" ? await parent(path) : undefined;
        entries.push(
          machineFileMetadata(path, {
            ...result.stat,
            ...(symlinkParent === undefined ? {} : { symlinkParent }),
          }),
        );
      }
      if (live.length > 0) request.check();
      return entries;
    },
    async readdir(path, signal) {
      if (runtimePathIsAbsent(path, signal)) return undefined;
      if (imageIsAuthoritative(path) && !inventory.needsLiveDirectory(path))
        return inventory.readdir(path)?.map((entry) => machineFileMetadata(entry.path, entry));
      const entries: KernelLowerFileSystemEntry[] = [];
      const request = machineFileRequest(options.files, options.signal, signal);
      const parent = liveParents(request);
      let cursor: string | undefined;
      do {
        const result = await request.single({
          id: "directory",
          op: "readdir",
          path,
          withStat: true,
          ...(cursor === undefined ? {} : { cursor }),
        });
        if ("error" in result) {
          if (absent(result.error.code)) return undefined;
          throw posixError(result.error);
        }
        if (result.op !== "readdir")
          throw request.unavailable("Machine returned the wrong directory operation");
        for (const entry of result.entries) {
          if (entry.stat === undefined)
            throw request.unavailable("Machine omitted directory metadata");
          const child = `${path === "/" ? "" : path}/${entry.name}`;
          const symlinkParent = entry.stat.type === "symlink" ? await parent(child) : undefined;
          entries.push(
            machineFileMetadata(child, {
              ...entry.stat,
              ...(symlinkParent === undefined ? {} : { symlinkParent }),
            }),
          );
        }
        cursor = result.nextCursor ?? undefined;
      } while (cursor !== undefined);
      request.check();
      return entries;
    },
    async readlink(path, signal) {
      if (runtimePathIsAbsent(path, signal))
        throw posixError({ code: "ENOENT", message: "Machine runtime path is absent" });
      if (imageIsAuthoritative(path)) {
        const target = inventory.readlink(path);
        if (target !== undefined) return target;
        throw posixError({ code: "EINVAL", message: "Machine path is not a symbolic link" });
      }
      return machineFileRequest(options.files, options.signal, signal).readlink(path);
    },
    async read(path, offset, length, signal) {
      const request = machineFileRequest(options.files, options.signal, signal);
      request.check();
      if (offset < 0n || offset > BigInt(Number.MAX_SAFE_INTEGER))
        throw posixError({
          code: "EOVERFLOW",
          message: "Machine file offset is outside the supported range",
        });
      if (!Number.isSafeInteger(length) || length < 0)
        throw posixError({ code: "EINVAL", message: "Invalid machine file read length" });
      const boundedLength = Math.min(length, MACHINE_FILES_MAX_CONTENT_BYTES);
      if (contentIsAuthoritative(path)) {
        let bytes: Uint8Array | undefined;
        try {
          bytes = await imageContent(path, Number(offset), boundedLength);
        } catch (cause) {
          request.check();
          throw request.unavailable("Image content validation failed", { cause });
        }
        request.check();
        if (bytes !== undefined && contentIsAuthoritative(path)) return bytes;
      }
      const result = await request.single({
        id: "bytes",
        op: "readRange",
        path,
        offset: Number(offset),
        length: boundedLength,
      });
      if ("error" in result) throw posixError(result.error);
      if (result.op !== "readRange")
        throw request.unavailable("Machine returned the wrong read operation");
      const bytes = decodeBase64(result.bytesBase64);
      if (bytes.byteLength !== result.bytesRead)
        throw request.unavailable("Machine file byte count does not match its payload");
      return bytes;
    },
  };
}

function absent(code: string) {
  return code === "ENOENT" || code === "ENOTDIR";
}

function posixError(error: { readonly code: string; readonly message: string }) {
  return Object.assign(new Error(error.message), { code: error.code });
}

function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}
