export const WS_ERRNO = Object.freeze({
  EAGAIN: 6,
  EBADF: 8,
  EINVAL: 28,
  EIO: 29,
  EMSGSIZE: 35,
  ENOBUFS: 42,
  EPIPE: 64,
  ENOTSUP: 58,
  EFAULT: 21,
} as const);

export const MAX_FRAME_BYTES = 1024 * 1024;
export const MAX_QUEUE_BYTES = 4 * 1024 * 1024;
export const MAX_URL_BYTES = 8 * 1024;
export const MAX_HEADER_BLOCK_BYTES = 64 * 1024;
export const MAX_REQUEST_BYTES = 16 + MAX_URL_BYTES + MAX_HEADER_BLOCK_BYTES;
export const MAX_HANDSHAKE_BODY_BYTES = 1024 * 1024;
export const MAX_HANDSHAKE_BYTES = MAX_HANDSHAKE_BODY_BYTES + MAX_HEADER_BLOCK_BYTES + 16;

export type KernelWebSocketHeader = readonly [name: string, value: string];

export interface KernelWebSocketRequest {
  readonly url: URL;
  readonly authority: string;
  readonly headers: readonly KernelWebSocketHeader[];
  readonly maxFrameBytes: number;
  readonly maxQueueBytes: number;
}

export interface KernelWebSocketHandshake {
  readonly status: number;
  readonly headers: readonly KernelWebSocketHeader[];
  readonly body: Uint8Array;
}

export type KernelWebSocketWireError = (typeof WS_ERRNO)[keyof typeof WS_ERRNO];

/** Decode the complete wasm32 request before creating any route side effect. */
export function decodeWebSocketRequest(
  source: Uint8Array,
): KernelWebSocketRequest | KernelWebSocketWireError {
  let offset = 0;
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
  const u32 = (): number | undefined => {
    if (source.byteLength - offset < 4) return undefined;
    const result = view.getUint32(offset, true);
    offset += 4;
    return result;
  };
  const bytes = (length: number): Uint8Array | undefined => {
    if (length > source.byteLength - offset) return undefined;
    const result = source.subarray(offset, offset + length);
    offset += length;
    return result;
  };

  const version = u32();
  const maxFrameBytes = u32();
  const maxQueueBytes = u32();
  const urlLength = u32();
  if (
    version === undefined ||
    maxFrameBytes === undefined ||
    maxQueueBytes === undefined ||
    urlLength === undefined
  ) {
    return WS_ERRNO.EINVAL;
  }
  if (version !== 1) return WS_ERRNO.ENOTSUP;
  if (
    maxFrameBytes < 1 ||
    maxFrameBytes > MAX_FRAME_BYTES ||
    maxQueueBytes < maxFrameBytes ||
    maxQueueBytes > MAX_QUEUE_BYTES ||
    urlLength < 1 ||
    urlLength > MAX_URL_BYTES
  ) {
    return WS_ERRNO.EINVAL;
  }

  const encodedUrl = bytes(urlLength);
  const headerCount = u32();
  if (encodedUrl === undefined || headerCount === undefined) return WS_ERRNO.EINVAL;

  let rawUrl: string;
  try {
    rawUrl = new TextDecoder("utf-8", { fatal: true }).decode(encodedUrl);
  } catch {
    return WS_ERRNO.EINVAL;
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return WS_ERRNO.EINVAL;
  }
  if (url.protocol !== "ws:" || url.username !== "" || url.password !== "" || url.hash !== "") {
    return WS_ERRNO.ENOTSUP;
  }
  if (!isLoopbackHostname(url.hostname)) return WS_ERRNO.ENOTSUP;

  const headers: KernelWebSocketHeader[] = [];
  let headerBlockBytes = 4;
  for (let index = 0; index < headerCount; index++) {
    const nameLength = u32();
    if (nameLength === undefined || nameLength < 1) return WS_ERRNO.EINVAL;
    const nameBytes = bytes(nameLength);
    const valueLength = u32();
    if (nameBytes === undefined || valueLength === undefined) return WS_ERRNO.EINVAL;
    const valueBytes = bytes(valueLength);
    if (valueBytes === undefined) return WS_ERRNO.EINVAL;
    headerBlockBytes += 8 + nameLength + valueLength;
    if (headerBlockBytes > MAX_HEADER_BLOCK_BYTES) return WS_ERRNO.EMSGSIZE;

    let name = "";
    for (const byte of nameBytes) {
      if (!isHeaderNameByte(byte)) return WS_ERRNO.EINVAL;
      name += String.fromCharCode(byte);
    }
    for (const byte of valueBytes) {
      if ((byte < 0x20 && byte !== 0x09) || byte === 0x7f) return WS_ERRNO.EINVAL;
    }
    headers.push([name, bytesToLatin1(valueBytes)]);
  }

  if (offset !== source.byteLength) return WS_ERRNO.EINVAL;
  return {
    url,
    authority: url.host,
    headers,
    maxFrameBytes,
    maxQueueBytes,
  };
}

export function encodeWebSocketHandshake(
  handshake: KernelWebSocketHandshake,
): Uint8Array | KernelWebSocketWireError {
  if (!Number.isSafeInteger(handshake.status) || handshake.status < 100 || handshake.status > 599) {
    return WS_ERRNO.EIO;
  }
  if (handshake.body.byteLength > MAX_HANDSHAKE_BODY_BYTES) return WS_ERRNO.EMSGSIZE;

  const headers: Array<readonly [Uint8Array, Uint8Array]> = [];
  let headerBlockBytes = 4;
  for (const [rawName, rawValue] of handshake.headers) {
    if (typeof rawName !== "string" || typeof rawValue !== "string") return WS_ERRNO.EIO;
    if (8 + rawName.length + rawValue.length > MAX_HEADER_BLOCK_BYTES - headerBlockBytes) {
      return WS_ERRNO.EMSGSIZE;
    }
    const name = encodeLatin1(rawName);
    const value = encodeLatin1(rawValue);
    if (name === undefined || value === undefined) return WS_ERRNO.EIO;
    if (8 + name.byteLength + value.byteLength > MAX_HEADER_BLOCK_BYTES - headerBlockBytes) {
      return WS_ERRNO.EMSGSIZE;
    }
    headerBlockBytes += 8 + name.byteLength + value.byteLength;
    if (headerBlockBytes > MAX_HEADER_BLOCK_BYTES) return WS_ERRNO.EMSGSIZE;
    headers.push([name, value]);
  }
  const totalBytes = 8 + headerBlockBytes + handshake.body.byteLength;
  if (totalBytes > MAX_HANDSHAKE_BYTES) return WS_ERRNO.EMSGSIZE;

  const output = new Uint8Array(totalBytes);
  const view = new DataView(output.buffer);
  let offset = 0;
  view.setUint32(offset, handshake.status, true);
  offset += 4;
  view.setUint32(offset, headers.length, true);
  offset += 4;
  for (const [name, value] of headers) {
    view.setUint32(offset, name.byteLength, true);
    offset += 4;
    output.set(name, offset);
    offset += name.byteLength;
    view.setUint32(offset, value.byteLength, true);
    offset += 4;
    output.set(value, offset);
    offset += value.byteLength;
  }
  view.setUint32(offset, handshake.body.byteLength, true);
  offset += 4;
  output.set(handshake.body, offset);
  return output;
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (normalized === "::1" || normalized === "localhost" || normalized.endsWith(".localhost")) {
    return true;
  }
  const ipv4 = normalized.split(".");
  return (
    ipv4.length === 4 &&
    ipv4.every((part) => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255) &&
    Number(ipv4[0]) === 127
  );
}

function isHeaderNameByte(byte: number): boolean {
  return (
    (byte >= 0x30 && byte <= 0x39) ||
    (byte >= 0x41 && byte <= 0x5a) ||
    (byte >= 0x61 && byte <= 0x7a) ||
    "!#$%&'*+-.^_`|~".includes(String.fromCharCode(byte))
  );
}

function bytesToLatin1(bytes: Uint8Array): string {
  let result = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 8192) {
    result += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return result;
}

function encodeLatin1(value: string): Uint8Array | undefined {
  const bytes = new Uint8Array(value.length);
  for (let offset = 0; offset < value.length; offset++) {
    const code = value.charCodeAt(offset);
    if (code > 0xff) return undefined;
    bytes[offset] = code;
  }
  return bytes;
}
