export class NodeProcessExitError extends Error {
  readonly code: number;
  constructor(code: number, cause?: unknown) {
    super(`process.exit(${code})`, cause === undefined ? undefined : { cause });
    this.name = "NodeProcessExitError";
    this.code = code;
  }
}
