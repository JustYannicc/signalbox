import {
  HTTP_LIMITS,
  MockHttpWireError,
  errorResponse,
  findHeaderEnd,
  parseJsonRequestBody,
  parseRequestHead,
  sseResponse,
} from "./MockHttpWire.mjs";

const ERRNO = Object.freeze({
  AGAIN: 6,
  BADF: 8,
  HOSTUNREACH: 23,
  IO: 29,
  NOTCONN: 53,
});

export class MockHttpSocketError extends Error {
  constructor(errno, message) {
    super(message);
    this.errno = errno;
  }
}

function fail(errno, message) {
  throw new MockHttpSocketError(errno, message);
}

export class MockHttpSocket {
  #listeners = { read: new Set(), write: new Set() };
  #request = new Uint8Array(0);
  #requestStart = null;
  #requestMeta = null;
  #expectedRequestLength = null;
  #response = null;
  #readOffset = 0;
  #closed = false;

  connected = false;
  recvTimeoutMs = null;

  connect(address) {
    if (this.#closed) fail(ERRNO.BADF, "Socket is closed");
    if (this.connected) fail(30, "Socket is already connected");
    if (address !== "mock.invalid:80") {
      fail(ERRNO.HOSTUNREACH, "Only mock.invalid:80 is available");
    }
    this.connected = true;
    this.#notify("write");
  }

  setReceiveTimeout(bytes) {
    if (bytes.byteLength !== 16) fail(28, "Invalid timeval size");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const seconds = view.getBigInt64(0, true);
    const micros = view.getBigInt64(8, true);
    if (seconds < 0n || micros < 0n || micros >= 1_000_000n) fail(28, "Invalid timeval");
    if (seconds * 1_000_000n + micros !== 2000n) {
      fail(58, "Only the R3 two millisecond receive timeout is supported");
    }
    this.recvTimeoutMs = 2;
  }

  send(bytes, mock) {
    if (this.#closed) fail(ERRNO.BADF, "Socket is closed");
    if (!this.connected) fail(ERRNO.NOTCONN, "Socket is not connected");
    if (this.#response) fail(ERRNO.IO, "Request is already complete");
    if (bytes.byteLength === 0) return 0;

    const nextLength = this.#request.byteLength + bytes.byteLength;
    if (nextLength > HTTP_LIMITS.headerBytes + HTTP_LIMITS.requestBodyBytes) {
      this.#setResponse(errorResponse(413, "Payload Too Large"));
      return bytes.byteLength;
    }
    const next = new Uint8Array(nextLength);
    next.set(this.#request);
    next.set(bytes, this.#request.byteLength);
    this.#request = next;
    this.#parseRequest(mock);
    return bytes.byteLength;
  }

  #parseRequest(mock) {
    if (this.#response) return;
    try {
      if (this.#requestMeta === null) {
        const headerEnd = findHeaderEnd(this.#request);
        if (headerEnd < 0) {
          if (this.#request.byteLength > HTTP_LIMITS.headerBytes) {
            this.#setResponse(errorResponse(431, "Request Header Fields Too Large"));
          }
          return;
        }
        if (headerEnd > HTTP_LIMITS.headerBytes) {
          this.#setResponse(errorResponse(431, "Request Header Fields Too Large"));
          return;
        }
        this.#requestStart = headerEnd + 4;
        this.#requestMeta = parseRequestHead(this.#request.subarray(0, headerEnd));
        this.#expectedRequestLength = this.#requestStart + this.#requestMeta.contentLength;
        if (this.#request.byteLength > this.#expectedRequestLength) {
          this.#setResponse(errorResponse(400, "Bad Request"));
          return;
        }
      }

      if (this.#request.byteLength < this.#expectedRequestLength) return;
      if (this.#request.byteLength > this.#expectedRequestLength) {
        this.#setResponse(errorResponse(400, "Bad Request"));
        return;
      }
      this.#finishRequest(mock);
    } catch (error) {
      const status = error instanceof MockHttpWireError ? error.status : 400;
      const reason = error instanceof MockHttpWireError ? error.reason : "Bad Request";
      this.#setResponse(errorResponse(status, reason));
    }
  }

  #finishRequest(mock) {
    const request = this.#requestMeta;
    if (request.version !== "HTTP/1.1") {
      this.#setResponse(errorResponse(505, "HTTP Version Not Supported"));
      return;
    }
    if (request.host !== "mock.invalid" && request.host !== "mock.invalid:80") {
      this.#setResponse(errorResponse(421, "Misdirected Request"));
      return;
    }
    if (request.target !== "/v1/responses") {
      this.#setResponse(errorResponse(404, "Not Found"));
      return;
    }
    if (request.method !== "POST") {
      this.#setResponse(errorResponse(405, "Method Not Allowed"));
      return;
    }

    const body = parseJsonRequestBody(
      this.#request.subarray(this.#requestStart, this.#expectedRequestLength),
    );
    let sse;
    try {
      sse = mock.respond(body);
    } catch {
      this.#setResponse(errorResponse(500, "Mock Response Failed"));
      return;
    }
    if (typeof sse !== "string") {
      this.#setResponse(errorResponse(500, "Mock Response Failed"));
      return;
    }
    this.#setResponse(sseResponse(sse));
  }

  #setResponse(response) {
    if (this.#response) return;
    this.#response = response;
    this.#notify("read");
  }

  #notify(direction) {
    const listeners = [...this.#listeners[direction]];
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // A readiness subscriber cannot break socket cleanup.
      }
    }
  }

  read(output) {
    if (this.#closed) fail(ERRNO.BADF, "Socket is closed");
    if (!this.#response) fail(ERRNO.AGAIN, "Response is not ready");
    const count = Math.min(output.byteLength, this.#response.byteLength - this.#readOffset);
    output.set(this.#response.subarray(this.#readOffset, this.#readOffset + count));
    this.#readOffset += count;
    return count;
  }

  ready(direction) {
    if (this.#closed) return { bytes: 0n, hangup: true };
    if (direction === "write") {
      if (!this.connected) return undefined;
      return this.#response ? { bytes: 0n, hangup: true } : { bytes: 0n };
    }
    if (!this.#response) return undefined;
    const remaining = this.#response.byteLength - this.#readOffset;
    return remaining > 0 ? { bytes: BigInt(remaining) } : { bytes: 0n, hangup: true };
  }

  subscribe(direction, notify) {
    const listeners = this.#listeners[direction];
    listeners.add(notify);
    return () => listeners.delete(notify);
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#notify("read");
    this.#notify("write");
    this.#listeners.read.clear();
    this.#listeners.write.clear();
  }

  get closed() {
    return this.#closed;
  }
}
