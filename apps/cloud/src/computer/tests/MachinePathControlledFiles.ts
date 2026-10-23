// @effect-diagnostics nodeBuiltinImport:off - controlled protocol fixtures encode file-link bytes.
import * as NodeBuffer from "node:buffer";
import {
  type MachineFileOperation,
  type MachineFileOperationResult,
  type MachineFileStat,
} from "@signalbox/runner-protocol/MachineFilesProtocol";
import {
  indexMachinePrograms,
  type MachineProgramEntry,
  type MachineProgramInventory,
  type MachineProgramInventoryIndex,
} from "../MachineProgramInventory.ts";
import type {
  MachineFileLookupInput,
  MachineFileSourceState,
  MachineFilesPort,
} from "../MachineFilesPort.ts";

/** Metadata-only lower files for ProductComputer boundary tests. It never invents executable bytes. */
export function controlledMachineFiles(inventory: MachineProgramInventory) {
  const index = indexMachinePrograms(inventory);
  const calls: MachineFileLookupInput[] = [];
  let state: MachineFileSourceState = {
    generation: 1,
    pristine: true,
    imageDigest: inventory.imageDigest,
  };

  const files: MachineFilesPort = {
    current: () => state,
    async markExecuted(generation) {
      if (generation !== state.generation) throw new Error("Controlled machine generation changed");
      state = { generation, pristine: false };
    },
    async lookup(input, signal) {
      calls.push(input);
      signal.throwIfAborted();
      if (input.generation !== state.generation) throw new Error("Stale controlled machine lookup");
      return {
        generation: input.generation,
        results: input.operations.map((operation) =>
          operationResult(operation, index.lookup, index.readdir, index.readlink),
        ),
      };
    },
  };

  return { files, calls, state: () => state };
}

function operationResult(
  operation: MachineFileOperation,
  lookup: MachineProgramInventoryIndex["lookup"],
  readdir: MachineProgramInventoryIndex["readdir"],
  readlink: MachineProgramInventoryIndex["readlink"],
): MachineFileOperationResult {
  switch (operation.op) {
    case "stat":
    case "lstat": {
      const entry = lookup([operation.path])[0];
      return entry === undefined
        ? missing(operation)
        : { id: operation.id, op: operation.op, stat: stat(entry) };
    }
    case "readdir": {
      const children = readdir(operation.path);
      if (children === undefined) return missing(operation);
      const afterCursor =
        operation.cursor === undefined
          ? children
          : children.filter(
              (entry) => entry.path.slice(entry.path.lastIndexOf("/") + 1) > operation.cursor!,
            );
      const page = afterCursor.slice(0, operation.limit ?? afterCursor.length);
      return {
        id: operation.id,
        op: "readdir",
        entries: page.map((entry) => ({
          name: entry.path.slice(entry.path.lastIndexOf("/") + 1),
          type: entry.type,
          ...(operation.withStat ? { stat: stat(entry) } : {}),
        })),
        nextCursor: null,
      };
    }
    case "readlink": {
      try {
        return {
          id: operation.id,
          op: "readlink",
          targetBase64: NodeBuffer.Buffer.from(readlink(operation.path)).toString("base64"),
        };
      } catch {
        return missing(operation);
      }
    }
    case "searchPath": {
      const directories = operation.path.split(":").map((path) => path || operation.cwd);
      const matches = operation.commands.map((command) => {
        const candidates = command.includes("/")
          ? [command.startsWith("/") ? command : `${operation.cwd}/${command}`]
          : directories.map((directory) => `${directory.replace(/\/$/, "")}/${command}`);
        for (const path of candidates) {
          const entry = lookup([path])[0];
          if (entry?.type === "file" && (entry.mode & 0o111) !== 0) {
            return { command, status: "found" as const, path, stat: stat(entry) };
          }
        }
        return { command, status: "not_found" as const };
      });
      return { id: operation.id, op: "searchPath", matches };
    }
    case "readRange":
      return {
        id: operation.id,
        op: operation.op,
        error: { code: "ENOTSUP", message: "Controlled metadata fixture has no file bytes." },
      };
  }
}

function missing(operation: MachineFileOperation): MachineFileOperationResult {
  return {
    id: operation.id,
    op: operation.op,
    error: { code: "ENOENT", message: "Controlled path is absent." },
  };
}

function stat(entry: MachineProgramEntry): MachineFileStat {
  return {
    mode: entry.mode,
    type: entry.type,
    size: entry.size,
    uid: entry.uid,
    gid: entry.gid,
    ...(entry.dev === undefined ? {} : { dev: entry.dev }),
    ...(entry.ino === undefined ? {} : { ino: entry.ino }),
    nlink: entry.nlink,
    atimeNs: entry.atimeNs,
    mtimeNs: entry.mtimeNs,
    ctimeNs: entry.ctimeNs,
  };
}
