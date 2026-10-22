import type { KernelExitStatus } from "../kernel/KernelProgramHost.ts";
import type {
  ReleaseChunkOmittedEvent,
  ReleaseChunkOmittedFailure,
} from "@t3tools/contracts/harnessReleaseOmission";

export type {
  ReleaseChunkOmittedEvent,
  ReleaseChunkOmittedFailure,
} from "@t3tools/contracts/harnessReleaseOmission";

export interface HarnessOwnedProcess {
  readonly exited: Promise<KernelExitStatus>;
  readonly abort: (reason?: unknown) => Promise<void>;
  /** Startup metadata contains no bootstrap contents or native stream bytes. */
  readonly startup?: () => HarnessProcessStartup;
}

export interface HarnessProcessStartup {
  /** Written means the existing stdin writer accepted the bytes, not that native parsed them. */
  readonly bootstrap: {
    readonly bytes: number;
    readonly state: "pending" | "written" | "failed";
  } | null;
  readonly wasi: "not-started" | "running" | "returned" | "failed";
  readonly exit: KernelExitStatus | null;
  /** The original WASI/startup throw, retained by identity. */
  readonly failure?: unknown;
}

export const RELEASE_CHUNK_OMITTED_SYMBOL = Symbol.for("signalbox.releaseChunkOmitted");

export const makeReleaseChunkOmittedFailure = (
  event: ReleaseChunkOmittedEvent,
): ReleaseChunkOmittedFailure => {
  const trace = new Error("Release module was omitted.");
  return {
    _tag: "ReleaseChunkOmittedFailure",
    code: event.code,
    inputPath: event.inputPath,
    tier: event.tier,
    message: trace.message,
    stack: trace.stack ?? trace.message,
  };
};

export interface HarnessRuntimeReporter {
  readonly releaseChunkOmitted: (
    event: ReleaseChunkOmittedEvent,
    failure?: ReleaseChunkOmittedFailure,
  ) => void | Promise<void>;
}

export interface HarnessProcessObserver {
  readonly started: (process: HarnessOwnedProcess) => void;
  readonly abandoned: (cause: unknown) => void;
}
