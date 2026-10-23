import {
  MACHINE_FILES_MAX_CONTENT_BYTES,
  MACHINE_FILES_MAX_OPERATIONS,
  type MachineFileOperation,
  type MachineFileOperationResult,
} from "@signalbox/runner-protocol/MachineFilesProtocol";
import {
  KernelFileSystemUnavailable,
  type KernelLowerFileSystemEntry,
  type KernelLowerFileSystemSource,
} from "../kernel/KernelLowerFileSystem.ts";
import { machineFileMetadata } from "./MachineFileMetadata.ts";
import { MachineFileLookupError, type MachineFilesPort } from "./MachineFilesPort.ts";
import { indexMachinePrograms, type MachineProgramInventory } from "./MachineProgramInventory.ts";

export interface ComputerMachineFileSystemOptions {
  readonly inventory: MachineProgramInventory;
  readonly files: MachineFilesPort;
  readonly signal: AbortSignal;
}

/** The image proves absence until the lifecycle owner records a machine command. */
export function createComputerMachineFileSystem(
  options: ComputerMachineFileSystemOptions,
): KernelLowerFileSystemSource {
  const inventory = indexMachinePrograms(options.inventory);
  const pristine = (path: string) => {
    const state = options.files.current();
    return (
      state.pristine &&
      state.imageDigest === options.inventory.imageDigest &&
      !inventory.isExcluded(path)
    );
  };
  const batch = async (operations: readonly MachineFileOperation[], signal?: AbortSignal) => {
    const owned = signal === undefined ? options.signal : AbortSignal.any([options.signal, signal]);
    owned.throwIfAborted();
    if (operations.length === 0) return [];
    const generation = options.files.current().generation;
    if (generation === null)
      throw new KernelFileSystemUnavailable(
        "A machine generation is required for live file lookup",
      );
    const results: MachineFileOperationResult[] = [];
    try {
      for (let offset = 0; offset < operations.length; offset += MACHINE_FILES_MAX_OPERATIONS) {
        const part = operations.slice(offset, offset + MACHINE_FILES_MAX_OPERATIONS);
        const response = await options.files.lookup({ generation, operations: part }, owned);
        if (response.generation !== generation)
          throw new MachineFileLookupError(
            "STALE_GENERATION",
            "Machine changed during filesystem lookup",
          );
        const byId = new Map(response.results.map((result) => [result.id, result]));
        for (const operation of part) {
          const result = byId.get(operation.id);
          if (result === undefined || result.op !== operation.op)
            throw new MachineFileLookupError(
              "LOOKUP_FAILED",
              "Machine file response is incomplete",
            );
          results.push(result);
        }
      }
      owned.throwIfAborted();
      return results;
    } catch (cause) {
      if (owned.aborted) throw owned.reason;
      throw new KernelFileSystemUnavailable("The machine could not answer a filesystem lookup", {
        cause,
      });
    }
  };
  const single = async (operation: MachineFileOperation, signal?: AbortSignal) => {
    const result = (await batch([operation], signal))[0];
    if (result === undefined)
      throw new KernelFileSystemUnavailable("Machine file response is missing");
    return result;
  };
  return {
    lookupKnown(paths) {
      options.signal.throwIfAborted();
      if (paths.some((path) => !pristine(path))) return undefined;
      return inventory
        .lookup(paths)
        .map((entry, index) =>
          entry === undefined ? undefined : machineFileMetadata(paths[index]!, entry),
        );
    },
    async lookup(paths, signal) {
      const captured = paths.map((path) => ({ path, image: pristine(path) }));
      const imagePaths = captured.filter((entry) => entry.image).map((entry) => entry.path);
      const image = imagePaths.length === 0 ? [] : inventory.lookup(imagePaths);
      const live = captured.filter((entry) => !entry.image);
      const results = await batch(
        live.map(({ path }, index) => ({ id: String(index), op: "lstat", path })),
        signal,
      );
      let imageIndex = 0;
      let liveIndex = 0;
      return captured.map(({ path, image: useImage }) => {
        if (useImage) {
          const entry = image[imageIndex++];
          return entry === undefined ? undefined : machineFileMetadata(path, entry);
        }
        const result = results[liveIndex++];
        if (result === undefined)
          throw new KernelFileSystemUnavailable("Machine file response is incomplete");
        if ("error" in result) {
          if (absent(result.error.code)) return undefined;
          throw posixError(result.error);
        }
        if (result.op !== "lstat")
          throw new KernelFileSystemUnavailable("Machine returned the wrong file operation");
        return machineFileMetadata(path, result.stat);
      });
    },
    async readdir(path, signal) {
      if (pristine(path) && !inventory.needsLiveDirectory(path))
        return inventory.readdir(path)?.map((entry) => machineFileMetadata(entry.path, entry));
      const entries: KernelLowerFileSystemEntry[] = [];
      let cursor: string | undefined;
      do {
        const result = await single(
          {
            id: "directory",
            op: "readdir",
            path,
            withStat: true,
            ...(cursor === undefined ? {} : { cursor }),
          },
          signal,
        );
        if ("error" in result) {
          if (absent(result.error.code)) return undefined;
          throw posixError(result.error);
        }
        if (result.op !== "readdir")
          throw new KernelFileSystemUnavailable("Machine returned the wrong directory operation");
        for (const entry of result.entries) {
          if (entry.stat === undefined)
            throw new KernelFileSystemUnavailable("Machine omitted directory metadata");
          entries.push(
            machineFileMetadata(`${path === "/" ? "" : path}/${entry.name}`, entry.stat),
          );
        }
        cursor = result.nextCursor ?? undefined;
      } while (cursor !== undefined);
      return entries;
    },
    async readlink(path, signal) {
      if (pristine(path)) {
        const target = inventory.readlink(path);
        if (target !== undefined) return target;
        throw posixError({ code: "EINVAL", message: "Machine path is not a symbolic link" });
      }
      const result = await single({ id: "link", op: "readlink", path }, signal);
      if ("error" in result) throw posixError(result.error);
      if (result.op !== "readlink")
        throw new KernelFileSystemUnavailable("Machine returned the wrong link operation");
      return new TextDecoder("utf-8", { fatal: true }).decode(decodeBase64(result.targetBase64));
    },
    async read(path, offset, length, signal) {
      if (offset < 0n || offset > BigInt(Number.MAX_SAFE_INTEGER))
        throw posixError({
          code: "EOVERFLOW",
          message: "Machine file offset is outside the supported range",
        });
      const result = await single(
        {
          id: "bytes",
          op: "readRange",
          path,
          offset: Number(offset),
          length: Math.min(length, MACHINE_FILES_MAX_CONTENT_BYTES),
        },
        signal,
      );
      if ("error" in result) throw posixError(result.error);
      if (result.op !== "readRange")
        throw new KernelFileSystemUnavailable("Machine returned the wrong read operation");
      const bytes = decodeBase64(result.bytesBase64);
      if (bytes.byteLength !== result.bytesRead)
        throw new KernelFileSystemUnavailable("Machine file byte count does not match its payload");
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
