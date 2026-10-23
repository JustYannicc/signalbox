// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { WasiError } from "./internal_wasi_memory.ts";

export type WasiCall<T> = Generator<unknown, T, unknown>;

export function* complete<T>(value: T | Promise<T>): WasiCall<T> {
  return (yield value) as T;
}

export function runSync<T>(call: WasiCall<T>): T {
  let result = call.next();
  while (!result.done) {
    if (isPromiseLike(result.value)) {
      const error = new TypeError("WASI call requires asynchronous execution");
      void Promise.resolve(result.value).catch(() => undefined);
      try {
        result = call.return(undefined as T);
        while (!result.done) {
          if (isPromiseLike(result.value)) {
            void Promise.resolve(result.value).catch(() => undefined);
            result = call.return(undefined as T);
          } else {
            result = call.next(result.value);
          }
        }
      } catch (cleanupError) {
        Object.defineProperty(error, "cause", { value: cleanupError });
      }
      throw error;
    }
    result = call.next(result.value);
  }
  return result.value;
}

export async function runAsync<T>(
  call: WasiCall<T>,
  runStep: <V>(step: () => V) => V = (step) => step(),
): Promise<T> {
  let result: { value: Promise<unknown> } | undefined;
  const advance = (step: () => IteratorResult<unknown, T>) =>
    runStep(() => {
      // The meter can fail after next/throw has already yielded backend work.
      const next = step();
      const owned = next.done
        ? { done: true as const, value: Promise.resolve(next.value) }
        : { done: false as const, value: Promise.resolve(next.value) };
      result = owned;
      void owned.value.catch(() => undefined);
      return owned;
    });
  try {
    let current = advance(() => call.next());
    while (!current.done) {
      let value: unknown;
      try {
        value = await current.value;
      } catch (error) {
        current = advance(() => call.throw(error));
        continue;
      }
      current = advance(() => call.next(value));
    }
    return current.value;
  } catch (error) {
    // Settle started work before unwinding, without feeding its value back into
    // the failed operation. Cleanup runs without the failing meter.
    if (result !== undefined) {
      try {
        await result.value;
      } catch {}
    }
    try {
      let cleanup = call.throw(error);
      while (!cleanup.done) {
        let value: unknown;
        try {
          value = await cleanup.value;
        } catch (cleanupError) {
          cleanup = call.throw(cleanupError);
          continue;
        }
        cleanup = call.next(value);
      }
      await cleanup.value;
    } catch {
      // Cleanup must not replace the original metering or operation failure.
    }
    throw error;
  }
}

export function mapErrno(error: unknown): number {
  if (error instanceof WasiError) {
    return error.errno;
  }

  if (error instanceof Error) {
    // Structured Error cloning keeps this message but drops WasiError's custom errno.
    const match = /^WASI error: (-?\d+)$/.exec(error.message);
    if (match !== null) {
      const errno = Number(match[1]);
      if (Number.isSafeInteger(errno)) return errno;
    }
  }

  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") {
      const errno = POSIX_ERRNO_TO_WASI.get(code);
      if (errno !== undefined) {
        return errno;
      }
    }
  }

  throw error;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    return false;
  }
  try {
    return typeof (value as { then?: unknown }).then === "function";
  } catch {
    return true;
  }
}

const POSIX_ERRNO_TO_WASI = new Map<string, number>([
  ["E2BIG", 1],
  ["EACCES", 2],
  ["EADDRINUSE", 3],
  ["EADDRNOTAVAIL", 4],
  ["EAFNOSUPPORT", 5],
  ["EAGAIN", 6],
  ["EWOULDBLOCK", 6],
  ["EALREADY", 7],
  ["EBADF", 8],
  ["EBADMSG", 9],
  ["EBUSY", 10],
  ["ECANCELED", 11],
  ["ECHILD", 12],
  ["ECONNABORTED", 13],
  ["ECONNREFUSED", 14],
  ["ECONNRESET", 15],
  ["EDEADLK", 16],
  ["EDEADLOCK", 16],
  ["EDESTADDRREQ", 17],
  ["EDOM", 18],
  ["EDQUOT", 19],
  ["EEXIST", 20],
  ["EFAULT", 21],
  ["EFBIG", 22],
  ["EHOSTUNREACH", 23],
  ["EIDRM", 24],
  ["EILSEQ", 25],
  ["EINPROGRESS", 26],
  ["EINTR", 27],
  ["EINVAL", 28],
  ["EIO", 29],
  ["EISCONN", 30],
  ["EISDIR", 31],
  ["ELOOP", 32],
  ["EMFILE", 33],
  ["EMLINK", 34],
  ["EMSGSIZE", 35],
  ["EMULTIHOP", 36],
  ["ENAMETOOLONG", 37],
  ["ENETDOWN", 38],
  ["ENETRESET", 39],
  ["ENETUNREACH", 40],
  ["ENFILE", 41],
  ["ENOBUFS", 42],
  ["ENODEV", 43],
  ["ENOENT", 44],
  ["ENOEXEC", 45],
  ["ENOLCK", 46],
  ["ENOLINK", 47],
  ["ENOMEM", 48],
  ["ENOMSG", 49],
  ["ENOPROTOOPT", 50],
  ["ENOSPC", 51],
  ["ENOSYS", 52],
  ["ENOTCONN", 53],
  ["ENOTDIR", 54],
  ["ENOTEMPTY", 55],
  ["ENOTRECOVERABLE", 56],
  ["ENOTSOCK", 57],
  ["ENOTSUP", 58],
  ["EOPNOTSUPP", 58],
  ["ENOTTY", 59],
  ["ENXIO", 60],
  ["EOVERFLOW", 61],
  ["EOWNERDEAD", 62],
  ["EPERM", 63],
  ["EPIPE", 64],
  ["EPROTO", 65],
  ["EPROTONOSUPPORT", 66],
  ["EPROTOTYPE", 67],
  ["ERANGE", 68],
  ["EROFS", 69],
  ["ESPIPE", 70],
  ["ESRCH", 71],
  ["ESTALE", 72],
  ["ETIMEDOUT", 73],
  ["ETXTBSY", 74],
  ["EXDEV", 75],
  ["ENOTCAPABLE", 76],
]);
