export const NET_ERRNO = {
  AFNOSUPPORT: 5,
  AGAIN: 6,
  BADF: 8,
  CANCELED: 11,
  FAULT: 21,
  INVAL: 28,
  IO: 29,
  ISCONN: 30,
  MFILE: 33,
  MSGSIZE: 35,
  NOTCONN: 53,
  NOTSOCK: 57,
  NOTSUP: 58,
} as const;

class HttpNetworkError extends Error {
  readonly errno: number;
  constructor(errno: number) {
    super("HTTP network operation failed.");
    this.errno = errno;
  }
}

export function fail(errno: number): never {
  throw new HttpNetworkError(errno);
}

export function errno(error: unknown): number {
  if (error instanceof HttpNetworkError) return error.errno;
  if (error instanceof Error && "code" in error) {
    switch (error.code) {
      case "EBADF":
        return NET_ERRNO.BADF;
      case "EINVAL":
        return NET_ERRNO.INVAL;
      case "EMFILE":
        return NET_ERRNO.MFILE;
      case "ECANCELED":
        return NET_ERRNO.CANCELED;
    }
  }
  return NET_ERRNO.IO;
}

export function u32(value: number): number {
  if (!Number.isInteger(value) || value < -0x8000_0000 || value > 0xffff_ffff)
    fail(NET_ERRNO.INVAL);
  return value >>> 0;
}

export function range(memory: WebAssembly.Memory, pointer: number, length: number): number {
  const offset = u32(pointer);
  const size = u32(length);
  if (offset > memory.buffer.byteLength || size > memory.buffer.byteLength - offset)
    fail(NET_ERRNO.FAULT);
  return offset;
}

export function readBytes(memory: WebAssembly.Memory, pointer: number, length: number): Uint8Array {
  return new Uint8Array(memory.buffer, range(memory, pointer, length), u32(length)).slice();
}

export function writeU32(memory: WebAssembly.Memory, pointer: number, value: number): void {
  new DataView(memory.buffer).setUint32(range(memory, pointer, 4), value, true);
}

export function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail(NET_ERRNO.INVAL);
  }
}

export function hasHttpControls(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if ((code < 32 && code !== 9) || code === 127) return true;
  }
  return false;
}
