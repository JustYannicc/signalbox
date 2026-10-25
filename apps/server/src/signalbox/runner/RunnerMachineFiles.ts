import {
  MACHINE_FILES_MAX_CONTENT_BYTES,
  MACHINE_FILES_MAX_FRAME_BYTES,
  machineFilesFrameBytes,
  type MachineFileOperation,
  type MachineFilesRequest,
  type MachineFilesResult,
} from "@signalbox/runner-protocol/MachineFilesProtocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as RunnerNativeFileSystem from "./RunnerNativeFileSystem.ts";

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

const make = Effect.gen(function* () {
  const native = yield* RunnerNativeFileSystem.RunnerNativeFileSystem;
  const runOperation = (requestId: string, operation: MachineFileOperation) =>
    native.runOperation(operation).pipe(
      Effect.mapError(
        (cause) =>
          new RunnerMachineFilesError({
            requestId,
            operationId: operation.id,
            operation: operation.op,
            stage: "native_operation",
            cause,
          }),
      ),
    );

  return RunnerMachineFiles.of({
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
});

export const layer = Layer.effect(RunnerMachineFiles, make);
