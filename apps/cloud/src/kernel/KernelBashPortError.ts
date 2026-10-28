export interface KernelBashPortOperation {
  readonly pid: number;
  /** The process capability ID identifies this kernel command across exec, independently of PID reuse. */
  readonly commandId: string;
  readonly operation: string;
}

class KernelBashPortError extends Error implements KernelBashPortOperation {
  readonly pid: number;
  readonly commandId: string;
  readonly operation: string;

  constructor(state: string, context: KernelBashPortOperation) {
    super(
      `Bash process port ${state} (pid=${context.pid}, commandId=${context.commandId}, operation=${context.operation})`,
    );
    this.pid = context.pid;
    this.commandId = context.commandId;
    this.operation = context.operation;
  }
}

export class KernelBashPortClosedError extends KernelBashPortError {
  constructor(context: KernelBashPortOperation) {
    super("is closed", context);
    this.name = "KernelBashPortClosedError";
  }
}

export class KernelBashPortCompletedError extends KernelBashPortError {
  constructor(context: KernelBashPortOperation) {
    super("has completed", context);
    this.name = "KernelBashPortCompletedError";
  }
}

export class KernelBashPortBusyError extends KernelBashPortError {
  readonly activeOperation: string;

  constructor(context: KernelBashPortOperation, activeOperation: string) {
    super(`is executing ${activeOperation}`, context);
    this.name = "KernelBashPortBusyError";
    this.activeOperation = activeOperation;
  }
}

/** A deferred image replacement lost its process before admission; no replacement ran. */
export function isKernelBashStaleExecError(error: unknown): boolean {
  return (
    (error instanceof KernelBashPortClosedError || error instanceof KernelBashPortCompletedError) &&
    error.operation === "exec"
  );
}
