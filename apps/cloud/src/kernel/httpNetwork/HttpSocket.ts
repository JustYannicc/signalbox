import type { KernelDescriptorResource, WasiPollResult } from "../KernelDescriptors.ts";
import { hostname, parseAddress, sameHostname, type HttpTarget } from "./Address.ts";
import { fail, errno, NET_ERRNO } from "./Memory.ts";
import { HttpRequestDecoder } from "./RequestDecoder.ts";
import { buildRequest } from "./RequestHead.ts";
import { HttpResponseQueue } from "./ResponseQueue.ts";
import { abortable, streamHttpResponse } from "./ResponseWire.ts";

type Direction = "read" | "write";

/** The descriptor table shares this object across dup/fork aliases. It holds no guest views. */
export class HttpSocket implements KernelDescriptorResource {
  readonly #fetch: (request: Request) => Promise<Response>;
  readonly #onClose: () => void;
  readonly #abort = new AbortController();
  readonly #listeners: Record<Direction, Set<() => void>> = { read: new Set(), write: new Set() };
  readonly #response = new HttpResponseQueue(() => this.#notify("read"));
  #decoder: HttpRequestDecoder | undefined = new HttpRequestDecoder();
  #target: HttpTarget | undefined;
  #tlsHostname: string | undefined;
  #sent = false;
  #started = false;
  #closed = false;
  #error: number | undefined;
  #task: Promise<void> = Promise.resolve();
  recvTimeoutMs: number | null = null;

  constructor(fetch: (request: Request) => Promise<Response>, onClose: () => void) {
    this.#fetch = fetch;
    this.#onClose = onClose;
  }

  get settled(): Promise<void> {
    return this.#task;
  }

  assertOpen(): void {
    if (this.#closed) fail(NET_ERRNO.BADF);
    if (this.#error !== undefined) fail(this.#error);
  }

  connect(address: string): void {
    this.assertOpen();
    if (this.#target !== undefined) fail(NET_ERRNO.ISCONN);
    this.#target = parseAddress(address);
    this.#notify("write");
  }

  tlsConnect(value: string): void {
    this.assertOpen();
    if (this.#target === undefined) fail(NET_ERRNO.NOTCONN);
    if (this.#sent || this.#tlsHostname !== undefined) fail(NET_ERRNO.INVAL);
    const validated = hostname(value);
    if (!sameHostname(validated, this.#target.hostname)) {
      this.abort(NET_ERRNO.INVAL);
      return fail(NET_ERRNO.INVAL);
    }
    // This commits the URL scheme before any request can reach the injected fetch callback.
    this.#tlsHostname = validated;
  }

  setReceiveTimeout(bytes: Uint8Array): void {
    this.assertOpen();
    if (bytes.length !== 16) fail(NET_ERRNO.INVAL);
    const value = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    const seconds = value.getBigInt64(0, true);
    const micros = value.getBigInt64(8, true);
    const total = seconds * 1_000_000n + micros;
    if (
      seconds < 0n ||
      micros < 0n ||
      micros >= 1_000_000n ||
      total > BigInt(Number.MAX_SAFE_INTEGER)
    )
      fail(NET_ERRNO.INVAL);
    this.recvTimeoutMs = total === 0n ? null : Number(total) / 1000;
  }

  send(bytes: Uint8Array): number {
    this.assertOpen();
    if (this.#target === undefined) fail(NET_ERRNO.NOTCONN);
    if (bytes.length === 0) return 0;
    if (this.#started) fail(NET_ERRNO.NOTSUP);
    this.#sent = true;
    try {
      const decoded = this.#decoder!.feed(bytes);
      if (decoded !== undefined) {
        const request = buildRequest(
          decoded.head,
          decoded.body,
          this.#target,
          this.#tlsHostname,
          this.#abort.signal,
        );
        this.#decoder = undefined;
        this.#started = true;
        this.#task = this.#exchange(request);
        this.#notify("write");
      }
    } catch (error) {
      this.abort(errno(error));
      throw error;
    }
    return bytes.length;
  }

  read(output: Uint8Array): number {
    if (this.#closed) fail(NET_ERRNO.BADF);
    if (this.#target === undefined) fail(NET_ERRNO.NOTCONN);
    return this.#response.read(output);
  }

  ready(direction: Direction): WasiPollResult | undefined {
    if (this.#closed) return { bytes: 0n, hangup: true };
    if (direction === "read") return this.#response.ready();
    if (this.#error !== undefined) return { bytes: 0n, hangup: true };
    return this.#target === undefined
      ? undefined
      : { bytes: 0n, ...(this.#started ? { hangup: true } : {}) };
  }

  subscribe(direction: Direction, notify: () => void): () => void {
    this.#listeners[direction].add(notify);
    return () => {
      this.#listeners[direction].delete(notify);
    };
  }

  abort(error: number = NET_ERRNO.CANCELED): void {
    if (this.#closed) return;
    this.#terminate(error);
  }

  #terminate(error: number): void {
    this.#error ??= error;
    this.#decoder = undefined;
    this.#abort.abort();
    this.#response.end(this.#error, true);
    this.#notify("write");
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#terminate(NET_ERRNO.BADF);
    this.#onClose();
    this.#listeners.read.clear();
    this.#listeners.write.clear();
  }

  async #exchange(request: Request): Promise<void> {
    let response: Response | undefined;
    const fetching = Promise.resolve().then(() => {
      if (request.signal.aborted) fail(NET_ERRNO.CANCELED);
      return this.#fetch(request);
    });
    try {
      response = await abortable(fetching, request.signal);
      await streamHttpResponse(response, request.method, request.signal, (bytes) =>
        this.#response.write(bytes),
      );
      this.#response.end();
    } catch (error) {
      this.#error ??= errno(error);
      this.#response.end(this.#error);
      if (response !== undefined && !response.bodyUsed)
        await response.body?.cancel().catch(() => undefined);
    } finally {
      // Aborting the guest wait does not transfer ownership of the transport or its late body.
      const fetched = await fetching.catch(() => undefined);
      if (fetched !== response) await fetched?.body?.cancel().catch(() => undefined);
    }
  }

  #notify(direction: Direction): void {
    const listeners = Array.from(this.#listeners[direction]);
    for (const notify of listeners) {
      try {
        notify();
      } catch {
        /* A subscriber cannot break socket cleanup. */
      }
    }
  }
}
