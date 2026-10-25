import { NodeSystemError } from "../process/NodeError.ts";

export type ChildProcessErrorCode = string | number | null;

export interface ChildProcessError extends Error {
  code?: ChildProcessErrorCode;
  killed?: boolean;
  signal?: string | null;
  cmd?: string;
  stdout?: Uint8Array | string | null;
  stderr?: Uint8Array | string | null;
  status?: number | null;
  syscall?: string;
  path?: string;
}

export function childProcessError(
  message: string,
  code?: ChildProcessErrorCode,
  details: Partial<Omit<ChildProcessError, keyof Error | "code">> = {},
): ChildProcessError {
  const error = new Error(message) as ChildProcessError;
  if (code !== undefined) error.code = code;
  Object.assign(error, details);
  return error;
}

export function abortError(): ChildProcessError {
  const error = childProcessError("The operation was aborted", "ABORT_ERR");
  error.name = "AbortError";
  return error;
}

export function asChildProcessError(error: unknown): ChildProcessError {
  if (isCode(error, "EBADF")) {
    return childProcessError("Bad file descriptor", "EBADF", { syscall: "spawn" });
  }
  if (error instanceof Error) return error as ChildProcessError;
  return childProcessError(String(error));
}

export function unwrapHostResult(
  result: unknown,
  operation: "spawn" | "signal" | "wait" | "reap",
): unknown {
  if (typeof result !== "object" || result === null || !("status" in result)) return result;

  const status = Reflect.get(result, "status");
  if (status === "ok") return Reflect.get(result, "value");
  if (status === "error") {
    const error = Reflect.get(result, "error");
    const code =
      typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
    const message =
      typeof error === "object" && error !== null ? Reflect.get(error, "message") : undefined;
    throw hostSystemError(
      String(code ?? "IO_ERROR"),
      String(message ?? "Kernel process operation failed"),
      operation,
    );
  }
  if (status === "would_block") {
    throw new NodeSystemError(
      "ENOTSUP",
      `child_process.${operation} cannot wait on a synchronous kernel result`,
      operation,
    );
  }
  return result;
}

function hostSystemError(
  code: string,
  message: string,
  operation: "spawn" | "signal" | "wait" | "reap",
): Error {
  const nodeCode = (() => {
    if (code === "NOT_FOUND") return operation === "spawn" ? "ENOENT" : "ESRCH";
    if (code === "INVALID_HANDLE" || code === "EXPIRED") return "ESRCH";
    if (code === "INVALID_ARGUMENT" || code === "ABI_MISMATCH") return "EINVAL";
    if (code === "PERMISSION_DENIED") return "EPERM";
    if (code === "RESOURCE_LIMIT" || code === "ALREADY_WAITING") return "EAGAIN";
    if (code === "UNSUPPORTED") return "ENOTSUP";
    if (code === "CANCELLED") return "ECANCELED";
    return "EIO";
  })();
  if (
    nodeCode === "EINVAL" ||
    nodeCode === "ENOTSUP" ||
    nodeCode === "ESRCH" ||
    nodeCode === "EPERM" ||
    nodeCode === "EAGAIN" ||
    nodeCode === "ECANCELED" ||
    nodeCode === "EIO"
  ) {
    return new NodeSystemError(nodeCode, message, operation);
  }
  return childProcessError(message, nodeCode, { syscall: operation } as Partial<ChildProcessError>);
}

export function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === code;
}
