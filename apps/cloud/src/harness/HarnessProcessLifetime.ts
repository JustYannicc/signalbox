import type { KernelExitStatus } from "../kernel/KernelProgramHost.ts";

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
}

export interface HarnessProcessObserver {
  readonly started: (process: HarnessOwnedProcess) => void;
  readonly abandoned: (cause: unknown) => void;
}
