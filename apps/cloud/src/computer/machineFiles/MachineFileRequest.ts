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
  let lastBatchOperations: readonly MachineFileOperation[] = [];
  const unavailable = (
    message: string,
    operations: readonly MachineFileOperation[],
    options?: ErrorOptions,
  ) => {
    const current = files.current();
    return new KernelFileSystemUnavailable(message, {
      ...options,
      filesystemContext: {
        operations: operations.map(({ op, path }) => ({ operation: op, path })),
        generationState: {
          requested: generation,
          current: current.generation,
          generationAbsent: current.generationAbsent === true,
          pristine: current.pristine,
          ...(current.imageDigest === undefined ? {} : { imageDigest: current.imageDigest }),
        },
      },
    });
  };
  const check = (operations: readonly MachineFileOperation[] = lastBatchOperations) => {
    owned.throwIfAborted();
    if (files.current().generation !== generation)
      throw unavailable("The machine could not answer a filesystem lookup", operations, {
        cause: new MachineFileLookupError(
          "STALE_GENERATION",
          "Machine changed during filesystem lookup",
        ),
      });
  };
  const batch = async (operations: readonly MachineFileOperation[]) => {
    owned.throwIfAborted();
    if (operations.length === 0) return [];
    lastBatchOperations = operations;
    if (generation === null)
      throw unavailable("A machine generation is required for live file lookup", operations);
    const results: MachineFileOperationResult[] = [];
    const requestPart = async (
      part: readonly MachineFileOperation[],
    ): Promise<MachineFileOperationResult[]> => {
      lastBatchOperations = part;
      check(part);
      try {
        const response = await files.lookup({ generation, operations: part }, owned);
        check(part);
        if (response.generation !== generation)
          throw new MachineFileLookupError(
            "STALE_GENERATION",
            "Machine changed during filesystem lookup",
          );
        const byId = new Map(response.results.map((result) => [result.id, result]));
        const ordered: MachineFileOperationResult[] = [];
        for (const operation of part) {
          const result = byId.get(operation.id);
          if (result === undefined || result.op !== operation.op)
            throw new MachineFileLookupError(
              "LOOKUP_FAILED",
              "Machine file response is incomplete",
            );
          ordered.push(result);
        }
        return ordered;
      } catch (cause) {
        if (owned.aborted) throw owned.reason;
        if (
          cause instanceof MachineFileLookupError &&
          cause.code === "FRAME_TOO_LARGE" &&
          part.length > 1
        ) {
          const middle = Math.floor(part.length / 2);
          return [
            ...(await requestPart(part.slice(0, middle))),
            ...(await requestPart(part.slice(middle))),
          ];
        }
        if (cause instanceof KernelFileSystemUnavailable && cause.filesystemContext !== undefined)
          throw cause;
        throw unavailable("The machine could not answer a filesystem lookup", part, { cause });
      }
    };
    for (let offset = 0; offset < operations.length; offset += MACHINE_FILES_MAX_OPERATIONS) {
      const part = operations.slice(offset, offset + MACHINE_FILES_MAX_OPERATIONS);
      results.push(...(await requestPart(part)));
    }
    check(operations);
    return results;
  };
  const single = async (operation: MachineFileOperation) => {
    const result = (await batch([operation]))[0];
    if (result === undefined) throw unavailable("Machine file response is missing", [operation]);
    return result;
  };
  return {
    batch,
    single,
    check,
    unavailable: (message: string, options?: ErrorOptions) =>
      unavailable(message, lastBatchOperations, options),
    async readlink(path: string) {
      const result = await single({ id: "link", op: "readlink", path });
      if ("error" in result)
        throw Object.assign(new Error(result.error.message), { code: result.error.code });
      if (result.op !== "readlink")
        throw unavailable("Machine returned the wrong link operation", [
          { id: "link", op: "readlink", path },
        ]);
      const bytes = Uint8Array.from(atob(result.targetBase64), (character) =>
        character.charCodeAt(0),
      );
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    },
  };
}
