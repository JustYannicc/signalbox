// @effect-diagnostics globalTimers:off - this Promise socket adapter bounds a pending Runner RPC without an Effect runtime.
import {
  MACHINE_FILES_MAX_CONTENT_BYTES,
  MACHINE_FILES_MAX_FRAME_BYTES,
  MACHINE_FILES_MAX_OPERATIONS,
  machineFilesFrameBytes,
  type MachineFileOperation,
  type MachineFilesRequest,
  type MachineFilesResult,
} from "@signalbox/runner-protocol/MachineFilesProtocol";
import type { RunnerExecConnection } from "../../thread/ThreadExecForwarder.ts";
import { MachineFileLookupError, type MachineFileLookupInput } from "../MachineFilesPort.ts";

interface Pending {
  readonly requestId: string;
  readonly socket: WebSocket;
  readonly generation: number;
  readonly connection: number;
  readonly resolve: (result: MachineFilesResult) => void;
  readonly reject: (error: MachineFileLookupError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly signal: AbortSignal;
  readonly abort: () => void;
}

export interface MachineFileRequestOptions {
  readonly timeoutMs: number;
  readonly nextRequestId: () => string;
}

/** Batches requests to the frame limit and owns request correlation and deadlines. */
export class RunnerMachineFileRequests {
  readonly #timeoutMs: number;
  readonly #nextRequestId: () => string;
  readonly #pending = new Map<string, Pending>();

  constructor(options: MachineFileRequestOptions) {
    this.#timeoutMs = options.timeoutMs;
    this.#nextRequestId = options.nextRequestId;
  }

  readonly split = (input: MachineFileLookupInput) => splitOperations(input);

  request(
    socket: WebSocket,
    connection: RunnerExecConnection,
    operations: ReadonlyArray<MachineFileOperation>,
    signal: AbortSignal,
  ) {
    const requestId = this.#nextRequestId();
    if (requestId.length === 0 || requestId.length > 128) {
      return Promise.reject(
        new MachineFileLookupError("INVALID_REQUEST", "Invalid machine file request id."),
      );
    }
    const request: MachineFilesRequest = {
      type: "machine.files.request",
      generation: connection.generation,
      requestId,
      operations,
    };
    let encodedBytes: number;
    try {
      encodedBytes = machineFilesFrameBytes(request);
    } catch (cause) {
      return Promise.reject(
        new MachineFileLookupError("INVALID_REQUEST", "Invalid machine file request.", { cause }),
      );
    }
    if (encodedBytes > MACHINE_FILES_MAX_FRAME_BYTES) {
      return Promise.reject(
        new MachineFileLookupError("FRAME_TOO_LARGE", "Split this machine file request and retry."),
      );
    }
    return new Promise<MachineFilesResult>((resolve, reject) => {
      const abort = () =>
        this.#settle(
          pending,
          new MachineFileLookupError("ABORTED", "Machine file lookup was aborted.", {
            cause: signal.reason,
          }),
        );
      const timer = setTimeout(
        () =>
          this.#settle(
            pending,
            new MachineFileLookupError("REQUEST_TIMEOUT", "Machine file lookup timed out."),
          ),
        this.#timeoutMs,
      );
      const pending: Pending = {
        requestId,
        socket,
        generation: connection.generation,
        connection: connection.connection,
        resolve,
        reject,
        timer,
        signal,
        abort,
      };
      this.#pending.set(requestId, pending);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      try {
        connection.send(request);
      } catch (cause) {
        this.#settle(
          pending,
          new MachineFileLookupError(
            "RUNNER_DISCONNECTED",
            "The machine Runner rejected the request.",
            {
              cause,
            },
          ),
        );
      }
    });
  }

  result(socket: WebSocket, generation: number, connection: number, result: MachineFilesResult) {
    if (result.generation !== generation) return;
    const pending = this.#pending.get(result.requestId);
    if (
      pending === undefined ||
      pending.socket !== socket ||
      pending.generation !== generation ||
      pending.connection !== connection
    ) {
      return;
    }
    this.#settle(pending, undefined, result);
  }

  failConnection(
    socket: WebSocket,
    generation: number,
    connection: number,
    error: MachineFileLookupError,
  ) {
    for (const pending of this.#pending.values()) {
      if (
        pending.socket === socket &&
        pending.generation === generation &&
        pending.connection === connection
      ) {
        this.#settle(pending, error);
      }
    }
  }

  failGeneration(generation: number) {
    for (const pending of this.#pending.values()) {
      if (pending.generation === generation) {
        this.#settle(
          pending,
          new MachineFileLookupError("RUNNER_DISCONNECTED", "The Runner generation ended."),
        );
      }
    }
  }

  dispose() {
    for (const pending of this.#pending.values()) {
      this.#settle(
        pending,
        new MachineFileLookupError("DISPOSED", "Machine file lookup is closed."),
      );
    }
  }

  #settle(pending: Pending, error?: MachineFileLookupError, result?: MachineFilesResult) {
    if (this.#pending.get(pending.requestId) !== pending) return;
    this.#pending.delete(pending.requestId);
    clearTimeout(pending.timer);
    pending.signal.removeEventListener("abort", pending.abort);
    if (error !== undefined) pending.reject(error);
    else pending.resolve(result!);
  }
}

function splitOperations(
  input: MachineFileLookupInput,
): ReadonlyArray<ReadonlyArray<MachineFileOperation>> {
  if (input.operations.length === 0) {
    throw new MachineFileLookupError(
      "INVALID_REQUEST",
      "Machine file lookup needs at least one operation.",
    );
  }
  if (
    input.operations.some(
      (operation) =>
        operation.op === "readRange" && operation.length > MACHINE_FILES_MAX_CONTENT_BYTES,
    )
  ) {
    throw new MachineFileLookupError(
      "FRAME_TOO_LARGE",
      "Read smaller ranges so each encoded machine file response stays within the frame limit.",
    );
  }
  const batches: Array<Array<MachineFileOperation>> = [];
  let batch: Array<MachineFileOperation> = [];
  const frameFor = (operations: ReadonlyArray<MachineFileOperation>): MachineFilesRequest => ({
    type: "machine.files.request",
    generation: input.generation,
    requestId: "r".repeat(36),
    operations,
  });
  for (const operation of input.operations) {
    const candidate = [...batch, operation];
    const tooMany = candidate.length > MACHINE_FILES_MAX_OPERATIONS;
    let candidateBytes = Number.POSITIVE_INFINITY;
    if (!tooMany) {
      try {
        candidateBytes = machineFilesFrameBytes(frameFor(candidate));
      } catch (cause) {
        if (batch.length === 0) {
          throw new MachineFileLookupError("INVALID_REQUEST", "Invalid machine file operation.", {
            cause,
          });
        }
      }
    }
    if (batch.length > 0 && (tooMany || candidateBytes > MACHINE_FILES_MAX_FRAME_BYTES)) {
      batches.push(batch);
      batch = [operation];
      continue;
    }
    batch = candidate;
    if (
      candidateBytes > MACHINE_FILES_MAX_FRAME_BYTES ||
      batch.length > MACHINE_FILES_MAX_OPERATIONS
    ) {
      throw new MachineFileLookupError(
        "FRAME_TOO_LARGE",
        "A single machine file operation exceeds the frame limit.",
      );
    }
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

export function machineFileLookupResultError(result: MachineFilesResult) {
  if (result.outcome.status !== "error") return undefined;
  const code =
    result.outcome.code === "stale_generation"
      ? "STALE_GENERATION"
      : result.outcome.code === "frame_too_large"
        ? "FRAME_TOO_LARGE"
        : result.outcome.code === "lookup_failed"
          ? "LOOKUP_FAILED"
          : "INVALID_REQUEST";
  return new MachineFileLookupError(code, result.outcome.message);
}
