// @effect-diagnostics nodeBuiltinImport:off - this adapter reads the Runner machine's native filesystem.
import * as NodeBuffer from "node:buffer";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  MACHINE_FILES_MAX_CONTENT_BYTES,
  MACHINE_FILES_MAX_FRAME_BYTES,
  MACHINE_FILES_MAX_READDIR_ENTRIES,
  machineFilesFrameBytes,
  type MachineFileOperation,
  type MachineFileOperationResult,
  type MachineFileStat,
  type MachineFilesRequest,
  type MachineFilesResult,
  type MachineFileType,
} from "@signalbox/runner-protocol/MachineFilesProtocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export class RunnerMachineFilesError extends Schema.TaggedError<RunnerMachineFilesError>()(
  "RunnerMachineFilesError",
  {
    requestId: Schema.String,
    operationId: Schema.optional(Schema.String),
    operation: Schema.optional(
      Schema.Literals(["stat", "lstat", "readdir", "readlink", "readRange", "searchPath"]),
    ),
    stage: Schema.Literals(["request_frame", "native_operation", "response_frame"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Runner machine file lookup failed.";
  }
}

export class RunnerMachineFiles extends Context.Service<
  RunnerMachineFiles,
  {
    readonly lookup: (
      request: MachineFilesRequest,
    ) => Effect.Effect<MachineFilesResult, RunnerMachineFilesError>;
  }
>()("t3/signalbox/runner/RunnerMachineFiles") {}

const fs = NodeFS.promises;

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
      ? await fs.stat(operation.path, { bigint: true })
      : await fs.lstat(operation.path, { bigint: true });
  return { id: operation.id, op: operation.op, stat: statShape(stats) } as const;
};

const readdirOperation = async (operation: Extract<MachineFileOperation, { op: "readdir" }>) => {
  const entries = await fs.readdir(operation.path, { withFileTypes: true, encoding: "utf8" });
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
                await fs.lstat(NodePath.join(operation.path, entry.name), { bigint: true }),
              ),
            }
          : {}),
      })),
    ),
    nextCursor: hasMore ? (page[page.length - 1]?.name ?? null) : null,
  };
};

const readlinkOperation = async (operation: Extract<MachineFileOperation, { op: "readlink" }>) => {
  const target = await fs.readlink(operation.path, { encoding: "buffer" });
  if (!NodeBuffer.Buffer.isBuffer(target)) throw new TypeError("Runner did not return link bytes");
  return { id: operation.id, op: "readlink" as const, targetBase64: target.toString("base64") };
};

const readRangeOperation = async (
  operation: Extract<MachineFileOperation, { op: "readRange" }>,
) => {
  if (operation.length > MACHINE_FILES_MAX_CONTENT_BYTES) {
    throw new RangeError("Machine file range exceeds the per-RPC content budget");
  }
  const handle = await fs.open(operation.path, "r");
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
          const stats = await fs.stat(candidate, { bigint: true });
          if (!stats.isFile()) {
            denied = true;
            continue;
          }
          await fs.access(candidate, NodeFS.constants.X_OK);
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

const frameTooLarge = (request: MachineFilesRequest): MachineFilesResult => ({
  type: "machine.files.result",
  generation: request.generation,
  requestId: request.requestId,
  outcome: {
    status: "error",
    code: "frame_too_large",
    message: "Split this read-only lookup into smaller batches or ranges and retry.",
  },
});

export const lookupFailedResult = (
  request: Pick<MachineFilesRequest, "generation" | "requestId">,
): MachineFilesResult => ({
  type: "machine.files.result",
  generation: request.generation,
  requestId: request.requestId,
  outcome: {
    status: "error",
    code: "lookup_failed",
    message: "Machine file lookup failed.",
  },
});

const runOperation = (
  requestId: string,
  operation: MachineFileOperation,
): Effect.Effect<MachineFileOperationResult, RunnerMachineFilesError> =>
  Effect.tryPromise({
    try: () => runNativeOperation(operation),
    catch: (cause) =>
      new RunnerMachineFilesError({
        requestId,
        operationId: operation.id,
        operation: operation.op,
        stage: "native_operation",
        cause,
      }),
  });

const make = (): RunnerMachineFiles["Service"] => ({
  lookup: (request) =>
    Effect.gen(function* () {
      const requestBytes = yield* Effect.try({
        try: () => machineFilesFrameBytes(request),
        catch: (cause) =>
          new RunnerMachineFilesError({
            requestId: request.requestId,
            stage: "request_frame",
            cause,
          }),
      });
      if (requestBytes > MACHINE_FILES_MAX_FRAME_BYTES) return frameTooLarge(request);

      const ids = new Set<string>();
      if (
        request.operations.some(({ id }) => {
          if (ids.has(id)) return true;
          ids.add(id);
          return false;
        })
      ) {
        return {
          type: "machine.files.result",
          generation: request.generation,
          requestId: request.requestId,
          outcome: {
            status: "error",
            code: "duplicate_operation_id",
            message: "Each operation in a machine file batch needs a unique id.",
          },
        } satisfies MachineFilesResult;
      }
      const contentBytes = request.operations.reduce(
        (total, operation) => total + (operation.op === "readRange" ? operation.length : 0),
        0,
      );
      if (contentBytes > MACHINE_FILES_MAX_CONTENT_BYTES) return frameTooLarge(request);

      const results = yield* Effect.forEach(
        request.operations,
        (operation) => runOperation(request.requestId, operation),
        { concurrency: "unbounded" },
      );
      const response: MachineFilesResult = {
        type: "machine.files.result",
        generation: request.generation,
        requestId: request.requestId,
        outcome: { status: "ok", results },
      };
      const responseBytes = yield* Effect.try({
        try: () => machineFilesFrameBytes(response),
        catch: (cause) =>
          new RunnerMachineFilesError({
            requestId: request.requestId,
            stage: "response_frame",
            cause,
          }),
      });
      return responseBytes <= MACHINE_FILES_MAX_FRAME_BYTES ? response : frameTooLarge(request);
    }),
});

export const layer = Layer.sync(RunnerMachineFiles, make);
