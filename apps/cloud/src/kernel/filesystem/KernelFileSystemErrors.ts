import { WasiError } from "../wasi/internal_wasi_memory.ts";
import { complete, runSync } from "../wasi/internal_wasi_calls.ts";

const WASI_ERRNO_CODES: readonly (string | undefined)[] = [
  undefined,
  "E2BIG",
  "EACCES",
  "EADDRINUSE",
  "EADDRNOTAVAIL",
  "EAFNOSUPPORT",
  "EAGAIN",
  "EALREADY",
  "EBADF",
  "EBADMSG",
  "EBUSY",
  "ECANCELED",
  "ECHILD",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EDEADLK",
  "EDESTADDRREQ",
  "EDOM",
  "EDQUOT",
  "EEXIST",
  "EFAULT",
  "EFBIG",
  "EHOSTUNREACH",
  "EIDRM",
  "EILSEQ",
  "EINPROGRESS",
  "EINTR",
  "EINVAL",
  "EIO",
  "EISCONN",
  "EISDIR",
  "ELOOP",
  "EMFILE",
  "EMLINK",
  "EMSGSIZE",
  "EMULTIHOP",
  "ENAMETOOLONG",
  "ENETDOWN",
  "ENETRESET",
  "ENETUNREACH",
  "ENFILE",
  "ENOBUFS",
  "ENODEV",
  "ENOENT",
  "ENOEXEC",
  "ENOLCK",
  "ENOLINK",
  "ENOMEM",
  "ENOMSG",
  "ENOPROTOOPT",
  "ENOSPC",
  "ENOSYS",
  "ENOTCONN",
  "ENOTDIR",
  "ENOTEMPTY",
  "ENOTRECOVERABLE",
  "ENOTSOCK",
  "ENOTSUP",
  "ENOTTY",
  "ENXIO",
  "EOVERFLOW",
  "EOWNERDEAD",
  "EPERM",
  "EPIPE",
  "EPROTO",
  "EPROTONOSUPPORT",
  "EPROTOTYPE",
  "ERANGE",
  "EROFS",
  "ESPIPE",
  "ESRCH",
  "ESTALE",
  "ETIMEDOUT",
  "ETXTBSY",
  "EXDEV",
  "ENOTCAPABLE",
];

export const kernelError = (code: string, message = code): Error & { code: string } =>
  Object.assign(new Error(message), { code });

/** Runs one sync or async-storage result through the synchronous kernel view. */
export function runKernelSync<T>(value: T | Promise<T>): T {
  return withKernelErrors(() => runSync(complete(value)));
}

export function withKernelErrors<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof WasiError) {
      throw kernelError(WASI_ERRNO_CODES[error.errno] ?? "EIO", error.message);
    }
    if (
      error instanceof TypeError &&
      error.message === "WASI call requires asynchronous execution"
    ) {
      throw kernelError("ENOTSUP", error.message);
    }
    throw error;
  }
}
