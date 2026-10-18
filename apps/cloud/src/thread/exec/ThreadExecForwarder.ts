import {
  EXEC_PROTOCOL_VERSION,
  type ExecReport,
  type ExecCommandMessage,
} from "@signalbox/runner-protocol/ExecProtocol";
import type { KernelCommand, KernelCommandForwarder } from "../../kernel/KernelCommandForwarder.ts";
import { KernelForwardingUnavailable } from "../../kernel/KernelCommandForwarder.ts";
import { RunnerExecChild } from "./RunnerExecChild.ts";

export interface ThreadExecWorkspace {
  /** Confirms Drive is mounted and returns a canonical guest path; preserves real path errors. */
  readonly canonicalCwd: (
    command: KernelCommand,
    generation: number,
    signal: AbortSignal,
  ) => Promise<string>;
}

export interface ThreadExecPolicy {
  /** Must approve the complete command before any Runner frame is sent. */
  readonly authorize: (
    command: KernelCommand,
    generation: number,
    signal: AbortSignal,
  ) => Promise<void>;
}

export interface ThreadExecLease {
  /** Acquire through ThreadRunner reconciliation, then resolve after this Runner's hello. */
  readonly acquire: (signal: AbortSignal) => Promise<{
    readonly generation: number;
    readonly connection: number;
    /** Keep the existing Runner lease held until this process closes. */
    readonly release: () => Promise<void>;
  }>;
}

export interface RunnerExecConnection {
  readonly generation: number;
  readonly connection: number;
  readonly protocolVersion: number;
  readonly exec: boolean;
  readonly send: (message: ExecCommandMessage) => void;
}

/** Called by runnerSockets after the existing lease hello has been accepted. */
export interface RunnerExecSocketHost {
  readonly connected: (socket: WebSocket, connection: RunnerExecConnection) => void;
  readonly report: (
    socket: WebSocket,
    generation: number,
    connection: number,
    report: ExecReport,
  ) => void;
  readonly disconnected: (socket: WebSocket, generation: number, connection: number) => void;
  /** The machine owner confirms native execution has ended, rather than merely disconnecting. */
  readonly generationEnded: (generation: number) => void;
}

export interface ThreadExecForwarderOptions {
  /** Absent until Drive revisions and canonical workspace mapping are proven. */
  readonly workspace?: ThreadExecWorkspace | undefined;
  /** Absent until the policy boundary is supplied. */
  readonly policy?: ThreadExecPolicy | undefined;
  /** Absent until ThreadRunner can hold a light machine through its reconcile path. */
  readonly lease?: ThreadExecLease | undefined;
  readonly acknowledgementTimeoutMs?: number | undefined;
}

interface TrackedLeaseRelease {
  readonly release: () => Promise<void>;
  inFlight: Promise<void> | null;
  attempted: boolean;
  lastFailure?: unknown;
}

const DEFAULT_ACK_TIMEOUT_MS = 30_000;

/** Uses only the current negotiated Runner connection and an existing lease. */
export class ThreadExecForwarder implements KernelCommandForwarder {
  readonly #options: ThreadExecForwarderOptions;
  readonly #ackTimeoutMs: number;
  readonly #children = new Map<string, RunnerExecChild>();
  readonly #cleanup = new Set<Promise<void>>();
  readonly #leaseReleases = new Set<TrackedLeaseRelease>();
  readonly #recoveredReleaseFailures = new Set<unknown>();
  #connection: { readonly socket: WebSocket; readonly value: RunnerExecConnection } | null = null;
  #disposed = false;

  constructor(options: ThreadExecForwarderOptions = {}) {
    this.#options = options;
    this.#ackTimeoutMs = options.acknowledgementTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.#ackTimeoutMs) || this.#ackTimeoutMs < 1) {
      throw new RangeError("acknowledgementTimeoutMs must be a positive safe integer");
    }
  }

  readonly socketHost: RunnerExecSocketHost = {
    connected: (socket, connection) => this.connected(socket, connection),
    report: (socket, generation, connection, report) =>
      this.report(socket, generation, connection, report),
    disconnected: (socket, generation, connection) =>
      this.disconnected(socket, generation, connection),
    generationEnded: (generation) => this.generationEnded(generation),
  };

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
      this.#failGeneration(current.generation, new Error("Runner connection was replaced"));
    }
    this.#connection = { socket, value: connection };
  }

  disconnected(socket: WebSocket, generation: number, connection: number) {
    const current = this.#connection;
    if (
      current === null ||
      current.socket !== socket ||
      current.value.generation !== generation ||
      current.value.connection !== connection
    ) {
      return;
    }
    this.#connection = null;
    this.#failGeneration(generation, new Error("Runner connection closed"));
  }

  /** A disconnected socket alone does not prove that its native processes stopped. */
  generationEnded(generation: number) {
    for (const child of this.#children.values()) {
      if (child.generation === generation) {
        child.generationEnded(new Error("Runner generation ended"));
      }
    }
  }

  report(socket: WebSocket, generation: number, connection: number, report: ExecReport) {
    const current = this.#connection;
    if (
      current === null ||
      current.socket !== socket ||
      current.value.generation !== generation ||
      current.value.connection !== connection ||
      report.generation !== generation
    ) {
      return;
    }
    this.#children.get(report.processId)?.report(report);
  }

  readonly spawn: KernelCommandForwarder["spawn"] = async (command, signal) => {
    if (this.#disposed) throw new Error("Runner exec forwarder is closed");
    if (signal.aborted)
      throw signal.reason instanceof Error ? signal.reason : new Error("Spawn cancelled");
    if (this.#options.lease === undefined) {
      throw unavailable(
        "RUNNER_NOT_READY",
        "The thread does not have a reconciled Runner lease for non-PTY processes yet.",
      );
    }
    let lease: Awaited<ReturnType<ThreadExecLease["acquire"]>>;
    try {
      lease = await this.#options.lease.acquire(signal);
    } catch {
      if (signal.aborted)
        throw signal.reason instanceof Error ? signal.reason : new Error("Spawn cancelled");
      throw unavailable(
        "RUNNER_NOT_READY",
        "This thread's Runner is not ready for a non-PTY process.",
      );
    }
    const leaseRelease = this.#trackLeaseRelease(lease.release);
    let leaseOwned = true;
    try {
      const connection = this.#connection;
      if (
        connection === null ||
        connection.value.generation !== lease.generation ||
        connection.value.connection !== lease.connection ||
        !connection.value.exec ||
        connection.value.protocolVersion < EXEC_PROTOCOL_VERSION
      ) {
        throw unavailable(
          "RUNNER_NOT_READY",
          "This thread's Runner does not support non-PTY processes yet.",
        );
      }
      if (signal.aborted)
        throw signal.reason instanceof Error ? signal.reason : new Error("Spawn cancelled");
      if (this.#options.workspace === undefined) {
        throw unavailable(
          "WORKSPACE_NOT_READY",
          "The thread workspace is not ready for a forwarded process.",
        );
      }
      const canonicalCwd = await this.#options.workspace.canonicalCwd(
        command,
        lease.generation,
        signal,
      );
      if (canonicalCwd !== command.cwd || !isWorkspacePath(canonicalCwd)) {
        throw unavailable(
          "WORKSPACE_NOT_READY",
          "The thread workspace is not ready for a forwarded process.",
        );
      }
      if (signal.aborted)
        throw signal.reason instanceof Error ? signal.reason : new Error("Spawn cancelled");
      if (this.#options.policy === undefined) {
        throw unavailable(
          "POLICY_NOT_READY",
          "Command forwarding is not enabled until its policy is available.",
        );
      }
      // An installed policy owns denial errors. Only a missing policy is a readiness failure.
      await this.#options.policy.authorize(command, lease.generation, signal);
      if (signal.aborted)
        throw signal.reason instanceof Error ? signal.reason : new Error("Spawn cancelled");
      if (this.#connection !== connection) {
        throw unavailable(
          "RUNNER_NOT_READY",
          "The thread's Runner changed while preparing the process.",
        );
      }
      const child = new RunnerExecChild({
        generation: lease.generation,
        acknowledgementTimeoutMs: this.#ackTimeoutMs,
        releaseLease: () => this.#releaseLease(leaseRelease),
        onDone: (processId, release) => {
          const cleanup = release
            .catch(() => undefined)
            .then(() => undefined)
            .finally(() => {
              this.#children.delete(processId);
              this.#cleanup.delete(cleanup);
            });
          this.#cleanup.add(cleanup);
        },
        send: (execCommand) => {
          if (this.#connection !== connection)
            throw new Error("Runner connection is no longer available");
          connection.value.send({ type: "exec.command", command: execCommand });
        },
      });
      leaseOwned = false;
      this.#children.set(child.processId, child);
      await child.start(command, canonicalCwd, signal);
      return child;
    } finally {
      if (leaseOwned) await this.#releaseLease(leaseRelease);
    }
  };

  async dispose() {
    this.#disposed = true;
    const children = [...this.#children.values()];
    const inFlightReleases = [...this.#leaseReleases].flatMap((release) =>
      release.inFlight === null ? [] : [release.inFlight],
    );
    const cleanup = await Promise.allSettled([
      ...children.map((child) => child.dispose()),
      ...this.#cleanup,
      ...inFlightReleases,
    ]);
    const releases = await Promise.allSettled(
      [...this.#leaseReleases]
        .filter((release) => release.attempted)
        .map((release) => this.#releaseLease(release)),
    );
    if (this.#children.size === 0) this.#connection = null;
    const failures = [
      ...cleanup.flatMap((result) =>
        result.status === "rejected" && !this.#recoveredReleaseFailures.has(result.reason)
          ? [result.reason]
          : [],
      ),
      ...releases.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
    ];
    this.#recoveredReleaseFailures.clear();
    if (failures.length > 0) throw new AggregateError(failures, "Runner process cleanup failed");
  }

  #trackLeaseRelease(release: () => Promise<void>) {
    const tracked: TrackedLeaseRelease = { release, inFlight: null, attempted: false };
    this.#leaseReleases.add(tracked);
    return tracked;
  }

  #releaseLease(tracked: TrackedLeaseRelease) {
    if (tracked.inFlight !== null) return tracked.inFlight;
    tracked.attempted = true;
    let attempt!: Promise<void>;
    attempt = Promise.resolve()
      .then(tracked.release)
      .then(
        () => {
          if (tracked.lastFailure !== undefined) {
            this.#recoveredReleaseFailures.add(tracked.lastFailure);
          }
          this.#leaseReleases.delete(tracked);
        },
        (error: unknown) => {
          tracked.lastFailure = error;
          throw error;
        },
      )
      .finally(() => {
        if (tracked.inFlight === attempt) tracked.inFlight = null;
      });
    tracked.inFlight = attempt;
    return attempt;
  }

  #failGeneration(generation: number, error: Error) {
    for (const child of this.#children.values()) {
      if (child.generation === generation) child.fail(error);
    }
  }
}

export const makeThreadExecForwarder = (options: ThreadExecForwarderOptions = {}) =>
  new ThreadExecForwarder(options);

function unavailable(
  code: "WORKSPACE_NOT_READY" | "POLICY_NOT_READY" | "RUNNER_NOT_READY",
  message: string,
) {
  return new KernelForwardingUnavailable(code, message);
}

function isWorkspacePath(path: string) {
  return (
    (path === "/workspace" || path.startsWith("/workspace/")) &&
    !path.includes("\\") &&
    !path.split("/").includes("..")
  );
}
