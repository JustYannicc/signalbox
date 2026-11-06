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
  EDEADLK: 35,
  ENAMETOOLONG: 36,
  ENOLCK: 37,
  ENOSYS: 38,
  ENOTEMPTY: 39,
  ELOOP: 40,
  EIDRM: 43,
  EBADMSG: 74,
  ENOLINK: 67,
  EPROTO: 71,
  EMULTIHOP: 72,
  ENOTSOCK: 88,
  ENOMSG: 42,
  EILSEQ: 84,
  EDESTADDRREQ: 89,
  EMSGSIZE: 90,
  EPROTOTYPE: 91,
  ENOPROTOOPT: 92,
  EPROTONOSUPPORT: 93,
  EAFNOSUPPORT: 97,
  EADDRINUSE: 98,
  EADDRNOTAVAIL: 99,
  ENETDOWN: 100,
  ENETUNREACH: 101,
  ENETRESET: 102,
  ECONNABORTED: 103,
  ECONNRESET: 104,
  ENOBUFS: 105,
  EISCONN: 106,
  ENOTCONN: 107,
  ETIMEDOUT: 110,
  ECONNREFUSED: 111,
  EHOSTUNREACH: 113,
  EALREADY: 114,
  EINPROGRESS: 115,
  ESTALE: 116,
  EDQUOT: 122,
  ECANCELED: 125,
  EOWNERDEAD: 130,
  ENOTRECOVERABLE: 131,
  EOVERFLOW: 75,
  ENOTSUP: 95,
  EOPNOTSUPP: 95,
  ENOTCAPABLE: 76,
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
  const expectedErrno = errnoByCode[sourceCode];
  if (
    cause instanceof Error &&
    source &&
    ("syscall" in source ? source.syscall : undefined) === syscall &&
    ("path" in source ? source.path : undefined) === path &&
    ("dest" in source ? source.dest : undefined) === dest &&
    ("errno" in source ? source.errno : undefined) ===
      (expectedErrno === undefined ? undefined : -expectedErrno)
  )
    return cause;
  const description = descriptionByCode[sourceCode] ?? sourceCode;
  const pathPart = path === undefined ? "" : ` '${path}'`;
  const destPart = dest === undefined ? "" : ` -> '${dest}'`;
  const error = new Error(`${sourceCode}: ${description}, ${syscall}${pathPart}${destPart}`, {
    cause,
  }) as NodeFsError;
  error.code = sourceCode;
  const sourceErrno = source && "errno" in source ? source.errno : undefined;
  if (typeof sourceErrno === "number") error.errno = sourceErrno;
  else if (expectedErrno !== undefined) error.errno = -expectedErrno;
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
