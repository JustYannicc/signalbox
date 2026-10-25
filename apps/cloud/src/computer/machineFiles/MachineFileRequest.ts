import {
  MACHINE_FILES_MAX_OPERATIONS,
  type MachineFileOperation,
  type MachineFileOperationResult,
} from "@signalbox/runner-protocol/MachineFilesProtocol";
import { KernelFileSystemUnavailable } from "../../kernel/KernelLowerFileSystem.ts";
import { MachineFileLookupError, type MachineFilesPort } from "../MachineFilesPort.ts";

/** Metadata and every ancestor needed to interpret it belong to one generation and abort scope. */
export function machineFileRequest(
  files: MachineFilesPort,
  owner: AbortSignal,
  signal?: AbortSignal,
) {
  const owned = signal === undefined ? owner : AbortSignal.any([owner, signal]);
  const generation = files.current().generation;
  const check = () => {
    owned.throwIfAborted();
    if (files.current().generation !== generation)
      throw new KernelFileSystemUnavailable("The machine could not answer a filesystem lookup", {
        cause: new MachineFileLookupError(
          "STALE_GENERATION",
          "Machine changed during filesystem lookup",
        ),
      });
  };
  const batch = async (operations: readonly MachineFileOperation[]) => {
    owned.throwIfAborted();
    if (operations.length === 0) return [];
    if (generation === null)
      throw new KernelFileSystemUnavailable(
        "A machine generation is required for live file lookup",
      );
    const results: MachineFileOperationResult[] = [];
    try {
      for (let offset = 0; offset < operations.length; offset += MACHINE_FILES_MAX_OPERATIONS) {
        check();
        const part = operations.slice(offset, offset + MACHINE_FILES_MAX_OPERATIONS);
        const response = await files.lookup({ generation, operations: part }, owned);
        check();
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
      check();
      return results;
    } catch (cause) {
      if (owned.aborted) throw owned.reason;
      throw new KernelFileSystemUnavailable("The machine could not answer a filesystem lookup", {
        cause,
      });
    }
  };
  const single = async (operation: MachineFileOperation) => {
    const result = (await batch([operation]))[0];
    if (result === undefined)
      throw new KernelFileSystemUnavailable("Machine file response is missing");
    return result;
  };
  return {
    batch,
    single,
    check,
    async readlink(path: string) {
      const result = await single({ id: "link", op: "readlink", path });
      if ("error" in result)
        throw Object.assign(new Error(result.error.message), { code: result.error.code });
      if (result.op !== "readlink")
        throw new KernelFileSystemUnavailable("Machine returned the wrong link operation");
      const bytes = Uint8Array.from(atob(result.targetBase64), (character) =>
        character.charCodeAt(0),
      );
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    },
  };
}
