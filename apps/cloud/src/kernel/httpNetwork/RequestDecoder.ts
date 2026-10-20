import { fail, NET_ERRNO } from "./Memory.ts";
import { parseRequestHead, type HttpRequestHead } from "./RequestHead.ts";
import { HTTP_LIMITS } from "./Types.ts";

export interface DecodedHttpRequest {
  readonly head: HttpRequestHead;
  readonly body: Uint8Array;
}

/** One bounded request per connection. A response advertises Connection: close. */
export class HttpRequestDecoder {
  #bytes = new Uint8Array(0);
  #length = 0;
  #scan = 0;
  #head: HttpRequestHead | undefined;
  #bodyStart = 0;
  #cursor = 0;
  #chunkLength: number | undefined;
  #bodyLength = 0;
  readonly #chunks: Array<readonly [number, number]> = [];
  #complete = false;

  feed(bytes: Uint8Array): DecodedHttpRequest | undefined {
    if (this.#complete) fail(NET_ERRNO.NOTSUP);
    const size = this.#length + bytes.length;
    if (size > HTTP_LIMITS.requestWireBytes) fail(NET_ERRNO.MSGSIZE);
    if (this.#bytes.length < size) {
      const next = new Uint8Array(
        Math.min(HTTP_LIMITS.requestWireBytes, Math.max(size, this.#bytes.length * 2, 1024)),
      );
      next.set(this.#bytes.subarray(0, this.#length));
      this.#bytes = next;
    }
    this.#bytes.set(bytes, this.#length);
    this.#length = size;
    if (this.#head === undefined) {
      // TLS records and other binary protocols cannot enter the HTTP fetch path.
      for (let i = this.#scan; i < Math.min(this.#length, 16); i++) {
        const value = this.#bytes[i]!;
        if (value < 0x20 || value > 0x7e) fail(NET_ERRNO.NOTSUP);
        if (value === 0x20) break;
      }
      const end = this.#findHeaderEnd();
      if (end === undefined) {
        if (this.#length > HTTP_LIMITS.headerBytes) fail(NET_ERRNO.MSGSIZE);
        return undefined;
      }
      if (end + 4 > HTTP_LIMITS.headerBytes) fail(NET_ERRNO.MSGSIZE);
      this.#head = parseRequestHead(this.#bytes.subarray(0, end));
      this.#bodyStart = this.#cursor = end + 4;
    }
    if (this.#head.chunked) return this.#chunked();
    const expected = this.#bodyStart + (this.#head.contentLength ?? 0);
    if (this.#length < expected) return undefined;
    if (this.#length !== expected) fail(NET_ERRNO.NOTSUP);
    return this.#finish(this.#bytes.subarray(this.#bodyStart, expected));
  }

  #findHeaderEnd(): number | undefined {
    for (let i = this.#scan; i + 3 < this.#length; i++) {
      if (
        this.#bytes[i] === 13 &&
        this.#bytes[i + 1] === 10 &&
        this.#bytes[i + 2] === 13 &&
        this.#bytes[i + 3] === 10
      )
        return i;
    }
    this.#scan = Math.max(0, this.#length - 3);
    return undefined;
  }

  #chunked(): DecodedHttpRequest | undefined {
    for (;;) {
      if (this.#chunkLength === undefined) {
        let end = this.#cursor;
        while (end + 1 < this.#length && !(this.#bytes[end] === 13 && this.#bytes[end + 1] === 10))
          end++;
        if (end - this.#cursor > 8192) fail(NET_ERRNO.MSGSIZE);
        if (end + 1 >= this.#length) return undefined;
        const line = new TextDecoder().decode(this.#bytes.subarray(this.#cursor, end));
        if (
          !/^[0-9a-fA-F]+(?:;[!#$%&'*+.^_`|~0-9A-Za-z-]+(?:=(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[\x20-\x21\x23-\x5b\x5d-\x7e]*"))?)*$/.test(
            line,
          )
        )
          fail(NET_ERRNO.INVAL);
        const length = Number.parseInt(line.split(";", 1)[0]!, 16);
        if (
          !Number.isSafeInteger(length) ||
          this.#bodyLength + length > HTTP_LIMITS.requestBodyBytes
        )
          fail(NET_ERRNO.MSGSIZE);
        if (this.#chunks.length >= 65536) fail(NET_ERRNO.MSGSIZE);
        this.#chunkLength = length;
        this.#cursor = end + 2;
      }
      const length = this.#chunkLength;
      if (length === 0) {
        if (this.#length < this.#cursor + 2) return undefined;
        if (this.#bytes[this.#cursor] !== 13 || this.#bytes[this.#cursor + 1] !== 10)
          fail(NET_ERRNO.NOTSUP);
        if (this.#length !== this.#cursor + 2) fail(NET_ERRNO.NOTSUP);
        const body = new Uint8Array(this.#bodyLength);
        let offset = 0;
        for (const [start, end] of this.#chunks) {
          body.set(this.#bytes.subarray(start, end), offset);
          offset += end - start;
        }
        return this.#finish(body);
      }
      if (this.#length < this.#cursor + length + 2) return undefined;
      const end = this.#cursor + length;
      if (this.#bytes[end] !== 13 || this.#bytes[end + 1] !== 10) fail(NET_ERRNO.INVAL);
      this.#chunks.push([this.#cursor, end]);
      this.#bodyLength += length;
      this.#cursor = end + 2;
      this.#chunkLength = undefined;
    }
  }

  #finish(body: Uint8Array): DecodedHttpRequest {
    this.#complete = true;
    const result = { head: this.#head!, body };
    this.#bytes = new Uint8Array(0);
    this.#chunks.length = 0;
    return result;
  }
}
