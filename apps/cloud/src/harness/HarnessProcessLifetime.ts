import {
  CLAUDE_CLI_STARTUP_FAILURE_REPORTER_KEY,
  RELEASE_MODULE_OMITTED_REPORTER_KEY,
} from "@t3tools/contracts/harnessReleaseKeys";
import type {
  ReleaseModuleOmittedEvent,
  ReleaseModuleOmittedFailure,
} from "@t3tools/contracts/harnessReleaseOmission";
import type { KernelExitStatus } from "../kernel/KernelProgramHost.ts";
import type { ClaudeSpawnDiagnostic } from "./ClaudeSpawnContext.ts";
import type { HarnessTurnStage } from "./HarnessTurnProgress.ts";
import type { CliViewTrace } from "./CliViewTrace.ts";

export type {
  ReleaseModuleOmittedEvent,
  ReleaseModuleOmittedFailure,
} from "@t3tools/contracts/harnessReleaseOmission";

export { CLAUDE_CLI_STARTUP_FAILURE_REPORTER_KEY };

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

export const RELEASE_MODULE_OMITTED_SYMBOL = Symbol.for(RELEASE_MODULE_OMITTED_REPORTER_KEY);

export const makeReleaseModuleOmittedFailure = (
  event: ReleaseModuleOmittedEvent,
): ReleaseModuleOmittedFailure => {
  const trace = new Error("Release module was omitted.");
  return {
    _tag: "ReleaseModuleOmittedFailure",
    code: event.code,
    inputPath: event.inputPath,
    tier: event.tier,
    message: trace.message,
    stack: trace.stack ?? trace.message,
  };
};

export interface HarnessRuntimeReporter {
  /** Claude's SDK remaps process context after bootstrap; Codex uses its RPC launch as-is. */
  readonly cliSpawnContext?: (context: ClaudeSpawnDiagnostic) => void;
  readonly turnMilestone?: (stage: HarnessTurnStage) => void;
  /** Cheap counters and durations from the CLI's filesystem view and Computer's machine layer. */
  readonly cliViewTrace?: (event: CliViewTrace) => void;
  /** Reports the caught rejection from the CLI's detached startup task. */
  readonly cliStartupFailure?: (cause: unknown) => void;
  readonly releaseModuleOmitted: (
    event: ReleaseModuleOmittedEvent,
    failure?: ReleaseModuleOmittedFailure,
  ) => void | Promise<void>;
}

export interface HarnessProcessObserver {
  readonly started: (process: HarnessOwnedProcess) => void;
  readonly abandoned: (cause: unknown) => void;
}
