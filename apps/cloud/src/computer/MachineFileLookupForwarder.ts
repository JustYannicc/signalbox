// @effect-diagnostics cryptoRandomUUID:off - this socket adapter creates correlation ids outside an Effect runtime.
import {
  type MachineFileOperationResult,
  type MachineFilesResult,
} from "@signalbox/runner-protocol/MachineFilesProtocol";
import type { RunnerExecConnection } from "../thread/ThreadExecForwarder.ts";
import {
  MachineFileLookupError,
  type MachineFileSourceAttestation,
  type MachineFileSourceState,
  type MachineFilesPort,
} from "./MachineFilesPort.ts";
import {
  machineFileLookupResultError,
  RunnerMachineFileRequests,
} from "./machineFiles/RunnerMachineFileRequests.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const EMPTY_STATE: MachineFileSourceState = Object.freeze({ generation: null, pristine: false });

export interface RunnerMachineFileLookupSocketHost {
  readonly connected: (socket: WebSocket, connection: RunnerExecConnection) => void;
  readonly result: (
    socket: WebSocket,
    generation: number,
    connection: number,
    result: MachineFilesResult,
  ) => void;
  readonly disconnected: (socket: WebSocket, generation: number, connection: number) => void;
  readonly generationEnded: (generation: number) => void;
}

export interface RunnerMachineFileLookupForwarderOptions {
  readonly source?: MachineFileSourceAttestation;
  readonly timeoutMs?: number;
  readonly nextRequestId?: () => string;
}

/** Correlates bounded file requests on the current Runner socket and its lifecycle generation. */
export class RunnerMachineFileLookupForwarder implements MachineFilesPort {
  readonly #source: MachineFileSourceAttestation | undefined;
  readonly #timeoutMs: number;
  readonly #nextRequestId: () => string;
  readonly #requests: RunnerMachineFileRequests;
  #connection: { readonly socket: WebSocket; readonly value: RunnerExecConnection } | null = null;
  #disposed = false;

  constructor(options: RunnerMachineFileLookupForwarderOptions = {}) {
    this.#source = options.source;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#nextRequestId = options.nextRequestId ?? (() => crypto.randomUUID());
    this.#requests = new RunnerMachineFileRequests({
      timeoutMs: this.#timeoutMs,
      nextRequestId: this.#nextRequestId,
    });
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1) {
      throw new RangeError("timeoutMs must be a positive safe integer");
    }
  }

  readonly socketHost: RunnerMachineFileLookupSocketHost = {
    connected: (socket, connection) => this.connected(socket, connection),
    result: (socket, generation, connection, result) =>
      this.#requests.result(socket, generation, connection, result),
    disconnected: (socket, generation, connection) =>
      this.disconnected(socket, generation, connection),
    generationEnded: (generation) => this.generationEnded(generation),
  };

  current(): MachineFileSourceState {
    const source = this.#source?.current() ?? null;
    const connection = this.#connection?.value;
    if (source === null) {
      return connection === undefined
        ? EMPTY_STATE
        : { generation: connection.generation, pristine: false };
    }
    if (connection === undefined) return source;
    if (connection.generation !== source.generation) {
      return { generation: source.generation, pristine: false };
    }
    return source;
  }

  connected(socket: WebSocket, connection: RunnerExecConnection) {
    if (this.#disposed) return;
    const current = this.#connection?.value;
    if (
      current !== undefined &&
      (connection.generation < current.generation ||
        (connection.generation === current.generation &&
          connection.connection <= current.connection))
    ) {
      return;
    }
    if (current !== undefined) {
      this.#requests.failConnection(
        this.#connection!.socket,
        current.generation,
        current.connection,
        new MachineFileLookupError("RUNNER_DISCONNECTED", "The Runner connection was replaced."),
      );
    }
    this.#connection = { socket, value: connection };
  }

  disconnected(socket: WebSocket, generation: number, connection: number) {
    if (!this.#matches(socket, generation, connection)) return;
    this.#connection = null;
    this.#requests.failConnection(
      socket,
      generation,
      connection,
      new MachineFileLookupError("RUNNER_DISCONNECTED", "The Runner connection closed."),
    );
  }

  generationEnded(generation: number) {
    this.#requests.failGeneration(generation);
    if (this.#connection?.value.generation === generation) this.#connection = null;
  }

  readonly lookup: MachineFilesPort["lookup"] = async (input, signal) => {
    if (this.#disposed)
      throw new MachineFileLookupError("DISPOSED", "Machine file lookup is closed.");
    if (signal.aborted) throw aborted(signal);
    const active = this.#connection;
    if (active === null) {
      throw new MachineFileLookupError("RUNNER_NOT_READY", "No machine Runner is connected.");
    }
    if (!active.value.machineFileLookup) {
      throw new MachineFileLookupError(
        "BACKEND_UPGRADE_REQUIRED",
        "This Runner does not support machine file lookup. Upgrade the machine backend.",
      );
    }
    const lifecycleState = this.#source?.current() ?? null;
    if (
      lifecycleState !== null &&
      (lifecycleState.generation !== null || lifecycleState.pristine) &&
      lifecycleState.generation !== active.value.generation
    ) {
      throw new MachineFileLookupError(
        "STALE_GENERATION",
        "Lifecycle state does not attest the connected Runner generation.",
      );
    }
    if (input.generation !== active.value.generation) {
      throw new MachineFileLookupError(
        "STALE_GENERATION",
        "The requested machine generation is stale.",
      );
    }
    if (signal.aborted) throw aborted(signal);
    const batches = this.#requests.split(input);
    const results: MachineFileOperationResult[] = [];
    for (const batch of batches) {
      const result = await this.#requests.request(active.socket, active.value, batch, signal);
      if (result.outcome.status === "error") throw machineFileLookupResultError(result);
      results.push(...result.outcome.results);
    }
    if (signal.aborted) throw aborted(signal);
    if (this.#connection !== active) {
      throw new MachineFileLookupError(
        "STALE_GENERATION",
        "The machine Runner changed during lookup.",
      );
    }
    return { generation: active.value.generation, results };
  };

  async dispose() {
    this.#disposed = true;
    this.#connection = null;
    this.#requests.dispose();
  }

  async markExecuted(generation: number) {
    const state = this.#source?.current() ?? null;
    if (state === null || !state.pristine) return;
    if (state.generation !== generation) {
      throw new MachineFileLookupError(
        "STALE_GENERATION",
        "The pristine attestation belongs to another generation.",
      );
    }
    const source = this.#source;
    if (source === undefined) return;
    await source.markExecuted(generation);
    const after = source.current();
    if (after === null || after.generation !== generation || after.pristine) {
      throw new MachineFileLookupError(
        "LOOKUP_FAILED",
        "The lifecycle owner did not persist the machine's dirty transition.",
      );
    }
  }

  #matches(socket: WebSocket, generation: number, connection: number) {
    const current = this.#connection;
    return (
      current !== null &&
      current.socket === socket &&
      current.value.generation === generation &&
      current.value.connection === connection
    );
  }
}

function aborted(signal: AbortSignal) {
  return new MachineFileLookupError("ABORTED", "Machine file lookup was aborted.", {
    cause: signal.reason,
  });
}
