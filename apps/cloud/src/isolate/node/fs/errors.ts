/* Adapted from Rivet agentOS's Node fs bridge at 63ae3b256749d47c7b3a7c463128d5deda57d1bb.
 * Licensed under Apache-2.0; see ../../bun/LICENSE.agentos and ../../bun/NOTICE.agentos.
 */
import { NodeFsAbortError } from "./abort.ts";

export interface NodeFsError extends Error {
  code: string;
  errno?: number;
  syscall?: string;
  path?: string;
  dest?: string;
}

const errnoByCode: Readonly<Record<string, number>> = {
  EPERM: 1,
  ENOENT: 2,
  ESRCH: 3,
  EINTR: 4,
  EIO: 5,
  ENXIO: 6,
  E2BIG: 7,
  ENOEXEC: 8,
  EBADF: 9,
  ECHILD: 10,
  EAGAIN: 11,
  EWOULDBLOCK: 11,
  ENOMEM: 12,
  EACCES: 13,
  EFAULT: 14,
  EBUSY: 16,
  EEXIST: 17,
  EXDEV: 18,
  ENODEV: 19,
  ENOTDIR: 20,
  EISDIR: 21,
  EINVAL: 22,
  ENFILE: 23,
  EMFILE: 24,
  ENOTTY: 25,
  ETXTBSY: 26,
  EFBIG: 27,
  ENOSPC: 28,
  ESPIPE: 29,
  EROFS: 30,
  EMLINK: 31,
  EPIPE: 32,
  EDOM: 33,
  ERANGE: 34,
  ENAMETOOLONG: 36,
  ENOSYS: 38,
  ENOTEMPTY: 39,
  ELOOP: 40,
  EOVERFLOW: 75,
  ENOTSUP: 95,
  EOPNOTSUPP: 95,
};

const descriptionByCode: Readonly<Record<string, string>> = {
  EACCES: "permission denied",
  EBADF: "bad file descriptor",
  EEXIST: "file already exists",
  EINVAL: "invalid argument",
  EISDIR: "is a directory",
  ELOOP: "too many symbolic links encountered",
  ENOENT: "no such file or directory",
  ENOTDIR: "not a directory",
  ENOTEMPTY: "directory not empty",
  ENOTSUP: "operation not supported",
  EROFS: "read-only file system",
};

export function codedError(code: string, message: string, syscall?: string): NodeFsError {
  const error = new Error(message) as NodeFsError;
  error.code = code;
  if (errnoByCode[code] !== undefined) error.errno = -errnoByCode[code];
  if (syscall !== undefined) error.syscall = syscall;
  return error;
}

export function unsupportedFs(syscall: string, path?: string): NodeFsError {
  const error = codedError(
    "ENOTSUP",
    `ENOTSUP: operation not supported, ${syscall}${path === undefined ? "" : ` '${path}'`}`,
    syscall,
  );
  if (path !== undefined) error.path = path;
  return error;
}

export function nodeFsError(
  cause: unknown,
  syscall: string,
  path?: string,
  dest?: string,
): unknown {
  if (
    cause instanceof NodeFsAbortError ||
    cause instanceof TypeError ||
    cause instanceof RangeError
  )
    return cause;
  const source = typeof cause === "object" && cause !== null ? cause : undefined;
  const sourceCode = source && "code" in source ? source.code : undefined;
  if (typeof sourceCode !== "string") return cause;
  const description = descriptionByCode[sourceCode] ?? sourceCode;
  const pathPart = path === undefined ? "" : ` '${path}'`;
  const destPart = dest === undefined ? "" : ` -> '${dest}'`;
  const error = new Error(`${sourceCode}: ${description}, ${syscall}${pathPart}${destPart}`, {
    cause,
  }) as NodeFsError;
  error.code = sourceCode;
  if (errnoByCode[sourceCode] !== undefined) error.errno = -errnoByCode[sourceCode];
  error.syscall = syscall;
  if (path !== undefined) error.path = path;
  if (dest !== undefined) error.dest = dest;
  return error;
}

export function callFs<T>(
  syscall: string,
  path: string | undefined,
  operation: () => T,
  dest?: string,
): T {
  try {
    return operation();
  } catch (cause) {
    throw nodeFsError(cause, syscall, path, dest);
  }
}
