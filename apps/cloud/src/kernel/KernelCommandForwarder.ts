import type { KernelResult } from "./KernelAbi.ts";

export interface KernelCommand {
  /** Executable identity is separate from argv[0], which may be overridden by the caller. */
  readonly executable: string;
  readonly argv: readonly string[];
  /** Canonical guest path, never a machine's physical workspace path. */
  readonly cwd: string;
  /** Complete process environment after applying the caller's environment policy. */
  readonly env: Readonly<Record<string, string>>;
}

export interface KernelCommandExit {
  readonly exitCode: number;
  readonly signal: number;
  readonly coreDumped: boolean;
}

/** The same byte-stream contract is used for registered and forwarded children. */
export interface KernelCommandChild {
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<KernelCommandExit>;
  readonly signal: (signal: number) => Promise<KernelResult<void>>;
  readonly dispose: () => Promise<void>;
}

export class KernelForwardingUnavailable extends Error {
  readonly code: "WORKSPACE_NOT_READY" | "POLICY_NOT_READY" | "RUNNER_NOT_READY";

  constructor(code: KernelForwardingUnavailable["code"], message: string) {
    super(message);
    this.name = "KernelForwardingUnavailable";
    this.code = code;
  }
}

/** Called only after registry lookup establishes that an executable is unregistered. */
export interface KernelCommandForwarder {
  readonly spawn: (command: KernelCommand, signal: AbortSignal) => Promise<KernelCommandChild>;
}
