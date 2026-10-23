// @effect-diagnostics nodeBuiltinImport:off - native BigInt metadata keeps nanoseconds and inode identities that Effect FileSystem converts to Date and number.
import * as NodeBuffer from "node:buffer";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import {
  MACHINE_FILES_MAX_CONTENT_BYTES,
  MACHINE_FILES_MAX_READDIR_ENTRIES,
  type MachineFileOperation,
  type MachineFileOperationResult,
  type MachineFileStat,
  type MachineFileType,
} from "@signalbox/runner-protocol/MachineFilesProtocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export class RunnerNativeFileSystemError extends Schema.TaggedError<RunnerNativeFileSystemError>()(
  "RunnerNativeFileSystemError",
  {
    operationId: Schema.String,
    operation: Schema.Literals(["stat", "lstat", "readdir", "readlink", "readRange", "searchPath"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Runner native filesystem operation failed.";
  }
}

export class RunnerNativeFileSystem extends Context.Service<
  RunnerNativeFileSystem,
  {
    readonly runOperation: (
      operation: MachineFileOperation,
    ) => Effect.Effect<MachineFileOperationResult, RunnerNativeFileSystemError>;
  }
>()("t3/signalbox/runner/RunnerNativeFileSystem") {}

const fileType = (stats: NodeFS.BigIntStats): MachineFileType => {
  if (stats.isFile()) return "file";
  if (stats.isDirectory()) return "directory";
  if (stats.isSymbolicLink()) return "symlink";
  if (stats.isFIFO()) return "fifo";
  if (stats.isSocket()) return "socket";
  if (stats.isCharacterDevice()) return "character";
  if (stats.isBlockDevice()) return "block";
  return "unknown";
};

const statShape = (stats: NodeFS.BigIntStats): MachineFileStat => ({
  mode: Number(stats.mode),
  type: fileType(stats),
  size: stats.size.toString(),
  uid: Number(stats.uid),
  gid: Number(stats.gid),
  dev: stats.dev.toString(),
  ino: stats.ino.toString(),
  nlink: stats.nlink.toString(),
  atimeNs: stats.atimeNs.toString(),
  mtimeNs: stats.mtimeNs.toString(),
  ctimeNs: stats.ctimeNs.toString(),
  birthtimeNs: stats.birthtimeNs.toString(),
});

const fileTypeOfDirent = (entry: {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  isFIFO(): boolean;
  isSocket(): boolean;
  isCharacterDevice(): boolean;
  isBlockDevice(): boolean;
}): MachineFileType => {
  if (entry.isFile()) return "file";
  if (entry.isDirectory()) return "directory";
  if (entry.isSymbolicLink()) return "symlink";
  if (entry.isFIFO()) return "fifo";
  if (entry.isSocket()) return "socket";
  if (entry.isCharacterDevice()) return "character";
  if (entry.isBlockDevice()) return "block";
  return "unknown";
};

const errorCode = (cause: unknown) => {
  if (typeof cause === "object" && cause !== null && "code" in cause) {
    const code = cause.code;
    if (typeof code === "string" && code.length > 0) return code.slice(0, 64);
  }
  return "EIO";
};

const isNodeError = (cause: unknown): cause is { readonly code: string } =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  typeof cause.code === "string" &&
  cause.code.length > 0;

const errorMessage = (cause: unknown) =>
  (cause instanceof Error ? cause.message : String(cause)).slice(0, 256);

const failure = (operation: MachineFileOperation, cause: unknown): MachineFileOperationResult => ({
  id: operation.id,
  op: operation.op,
  error: { code: errorCode(cause), message: errorMessage(cause) },
});

const statOperation = async (
  operation: Extract<MachineFileOperation, { op: "stat" | "lstat" }>,
) => {
  const stats =
    operation.op === "stat"
      ? await NodeFS.promises.stat(operation.path, { bigint: true })
      : await NodeFS.promises.lstat(operation.path, { bigint: true });
  return { id: operation.id, op: operation.op, stat: statShape(stats) } as const;
};

const readdirOperation = async (operation: Extract<MachineFileOperation, { op: "readdir" }>) => {
  const entries = await NodeFS.promises.readdir(operation.path, {
    withFileTypes: true,
    encoding: "utf8",
  });
  entries.sort((left, right) =>
    NodeBuffer.Buffer.compare(
      NodeBuffer.Buffer.from(left.name),
      NodeBuffer.Buffer.from(right.name),
    ),
  );
  const afterCursor =
    operation.cursor === undefined
      ? entries
      : entries.filter(
          (entry) =>
            NodeBuffer.Buffer.compare(
              NodeBuffer.Buffer.from(entry.name),
              NodeBuffer.Buffer.from(operation.cursor!),
            ) > 0,
        );
  const limit = operation.limit ?? MACHINE_FILES_MAX_READDIR_ENTRIES;
  const page = afterCursor.slice(0, limit);
  const hasMore = afterCursor.length > page.length;
  return {
    id: operation.id,
    op: "readdir" as const,
    entries: await Promise.all(
      page.map(async (entry) => ({
        name: entry.name,
        type: fileTypeOfDirent(entry),
        ...(operation.withStat === true
          ? {
              stat: statShape(
                await NodeFS.promises.lstat(NodePath.join(operation.path, entry.name), {
                  bigint: true,
                }),
              ),
            }
          : {}),
      })),
    ),
    nextCursor: hasMore ? (page[page.length - 1]?.name ?? null) : null,
  };
};

const readlinkOperation = async (operation: Extract<MachineFileOperation, { op: "readlink" }>) => {
  const target = await NodeFS.promises.readlink(operation.path, { encoding: "buffer" });
  if (!NodeBuffer.Buffer.isBuffer(target)) throw new TypeError("Runner did not return link bytes");
  return { id: operation.id, op: "readlink" as const, targetBase64: target.toString("base64") };
};

const readRangeOperation = async (
  operation: Extract<MachineFileOperation, { op: "readRange" }>,
) => {
  if (operation.length > MACHINE_FILES_MAX_CONTENT_BYTES) {
    throw new RangeError("Machine file range exceeds the per-RPC content budget");
  }
  const handle = await NodeFS.promises.open(operation.path, "r");
  try {
    const bytes = NodeBuffer.Buffer.alloc(operation.length);
    const { bytesRead } = await handle.read(bytes, 0, operation.length, operation.offset);
    const after = await handle.stat({ bigint: true });
    return {
      id: operation.id,
      op: "readRange" as const,
      offset: operation.offset,
      bytesRead,
      bytesBase64: bytes.subarray(0, bytesRead).toString("base64"),
      eof: BigInt(operation.offset) + BigInt(bytesRead) >= after.size,
    };
  } finally {
    await handle.close();
  }
};

const searchPathOperation = async (
  operation: Extract<MachineFileOperation, { op: "searchPath" }>,
) => {
  const directories = operation.path.split(":").map((entry) => entry || operation.cwd);
  const matches = await Promise.all(
    operation.commands.map(async (command) => {
      const candidates = command.includes("/")
        ? [absolutePath(operation.cwd, command)]
        : directories.map((directory) =>
            absolutePath(operation.cwd, `${directory.replace(/\/$/, "")}/${command}`),
          );
      let denied = false;
      for (const candidate of candidates) {
        try {
          const stats = await NodeFS.promises.stat(candidate, { bigint: true });
          if (!stats.isFile()) {
            denied = true;
            continue;
          }
          await NodeFS.promises.access(candidate, NodeFS.constants.X_OK);
          return { command, status: "found" as const, path: candidate, stat: statShape(stats) };
        } catch (cause) {
          const code = errorCode(cause);
          if (code === "EACCES" || code === "EPERM") denied = true;
          else if (code !== "ENOENT" && code !== "ENOTDIR") throw cause;
        }
      }
      return {
        command,
        status: denied ? ("permission_denied" as const) : ("not_found" as const),
      };
    }),
  );
  return { id: operation.id, op: "searchPath" as const, matches };
};

function absolutePath(cwd: string, path: string): string {
  // Lexical normalization would erase `..` before the native filesystem follows a symlink.
  return path.startsWith("/") ? path : `${cwd.replace(/\/$/, "")}/${path}`;
}

const runNativeOperation = async (
  operation: MachineFileOperation,
): Promise<MachineFileOperationResult> => {
  try {
    switch (operation.op) {
      case "stat":
      case "lstat":
        return await statOperation(operation);
      case "readdir":
        return await readdirOperation(operation);
      case "readlink":
        return await readlinkOperation(operation);
      case "readRange":
        return await readRangeOperation(operation);
      case "searchPath":
        return await searchPathOperation(operation);
    }
  } catch (cause) {
    if (isNodeError(cause)) return failure(operation, cause);
    throw cause;
  }
};

const make = (): RunnerNativeFileSystem["Service"] => ({
  runOperation: (operation) =>
    Effect.tryPromise({
      try: () => runNativeOperation(operation),
      catch: (cause) =>
        new RunnerNativeFileSystemError({
          operationId: operation.id,
          operation: operation.op,
          cause,
        }),
    }),
});

export const layer = Layer.sync(RunnerNativeFileSystem, make);
