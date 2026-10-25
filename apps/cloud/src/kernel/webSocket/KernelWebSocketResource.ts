import type { KernelWebSocketWebSocket } from "./KernelWebSocketTypes.ts";
import type { KernelDescriptorResource } from "../KernelDescriptors.ts";
import { encodeWebSocketHandshake, WS_ERRNO } from "./KernelWebSocketWire.ts";
import {
  WebSocketRouteError,
  type NormalizedWebSocketRouteResponse,
} from "./KernelWebSocketResponse.ts";

const OPEN = 1;
const CONNECTING = 0;
const CLOSING = 2;
const CLOSED = 3;

type Direction = "read" | "write";
type Frame = {
  readonly id: number;
  readonly opcode: number;
  readonly data: Uint8Array;
  readonly charge: number;
};
type OutgoingFrame = { readonly opcode: 1 | 2; readonly data: Uint8Array; readonly charge: number };

export interface KernelWebSocketResourceOptions {
  readonly maxFrameBytes: number;
  readonly maxQueueBytes: number;
}

/** One socket resource shared by every descriptor alias. It retains no wasm memory views. */
export class KernelWebSocketResource implements KernelDescriptorResource {
  readonly #maxFrameBytes: number;
  readonly #maxQueueBytes: number;
  readonly #abort = new AbortController();
  readonly #subscribers: Record<Direction, Set<() => void>> = {
    read: new Set(),
    write: new Set(),
  };
  readonly #receiveQueue: Frame[] = [];
  readonly #sendQueue: OutgoingFrame[] = [];
  readonly #socketListeners: Array<readonly [string, EventListener]> = [];
  #socket: KernelWebSocketWebSocket | undefined;
  #state: "connecting" | "open" | "closing" | "closed" = "connecting";
  #handshake: Uint8Array | undefined;
  #handshakeError: number | undefined;
  #handshakeConsumed = false;
  #nextFrameId = 0;
  #receiveBytes = 0;
  #sendBytes = 0;
  #fatalErrno: number | undefined;
  #closeRequested = false;
  #nativeCloseRequested = false;
  #writeWait: "drain" | "close" | undefined;
  #drainScheduled = false;
  #disposed = false;

  constructor(options: KernelWebSocketResourceOptions) {
    this.#maxFrameBytes = options.maxFrameBytes;
    this.#maxQueueBytes = options.maxQueueBytes;
  }

  get signal(): AbortSignal {
    return this.#abort.signal;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  accept(response: NormalizedWebSocketRouteResponse): void {
    if (this.#disposed) {
      this.#closeSocket(response.webSocket);
      return;
    }

    const encoded = encodeWebSocketHandshake(response.handshake);
    if (typeof encoded === "number") {
      this.#handshakeError = encoded;
      this.#fatalErrno = encoded;
      this.#state = "closed";
      this.#closeSocket(response.webSocket);
      this.#notifyBoth();
      return;
    }
    this.#handshake = encoded;

    if (response.handshake.status !== 101) {
      this.#state = "closed";
      this.#closeSocket(response.webSocket);
      this.#notifyBoth();
      return;
    }

    if (response.webSocket === undefined) {
      this.#handshakeError = WS_ERRNO.EIO;
      this.#fatalErrno = WS_ERRNO.EIO;
      this.#handshake = undefined;
      this.#state = "closed";
      this.#notifyBoth();
      return;
    }
    this.#attach(response.webSocket);
    this.#notify("read");
    if (this.#closeRequested) this.#closeNativeWhenDrained();
  }

  routeFailed(error: unknown): void {
    if (this.#disposed) return;
    const errno = error instanceof WebSocketRouteError ? error.errno : WS_ERRNO.EIO;
    this.#handshakeError = errno;
    this.#handshake = undefined;
    this.#fatalErrno = errno;
    this.#state = "closed";
    this.#detachSocket(true);
    this.#notifyBoth();
  }

  handshakeState():
    | { readonly status: "pending" }
    | { readonly status: "error"; readonly errno: number }
    | { readonly status: "consumed" }
    | { readonly status: "ready"; readonly bytes: Uint8Array } {
    if (this.#handshakeConsumed) return { status: "consumed" };
    if (this.#handshakeError !== undefined) return { status: "error", errno: this.#handshakeError };
    if (this.#handshake === undefined) return { status: "pending" };
    return { status: "ready", bytes: this.#handshake };
  }

  consumeHandshake(): void {
    this.#handshakeConsumed = true;
    this.#handshake = undefined;
    this.#notify("read");
  }

  receiveState():
    | { readonly status: "pending" }
    | { readonly status: "error"; readonly errno: number }
    | { readonly status: "eof" }
    | { readonly status: "frame"; readonly frame: Frame } {
    const frame = this.#receiveQueue[0];
    if (frame !== undefined) return { status: "frame", frame };
    if (this.#fatalErrno !== undefined) return { status: "error", errno: this.#fatalErrno };
    if (this.#state === "closed") return { status: "eof" };
    return { status: "pending" };
  }

  consumeFrame(frame: Frame): void {
    if (this.#receiveQueue[0]?.id !== frame.id) return;
    this.#receiveQueue.shift();
    this.#receiveBytes -= frame.charge;
    this.#notify("read");
  }

  ready(direction: Direction): { readonly bytes: bigint; readonly hangup?: boolean } | undefined {
    if (this.#disposed) return { bytes: 0n, hangup: true };
    if (direction === "read") {
      const frame = this.#receiveQueue[0];
      if (frame !== undefined) return { bytes: BigInt(frame.data.byteLength) };
      if (this.#handshake !== undefined && !this.#handshakeConsumed) {
        return { bytes: BigInt(this.#handshake.byteLength) };
      }
      if (
        this.#handshakeError !== undefined ||
        this.#fatalErrno !== undefined ||
        this.#state === "closed"
      ) {
        return { bytes: 0n, hangup: true };
      }
      return undefined;
    }
    if (this.#fatalErrno !== undefined) return { bytes: 0n, hangup: true };
    if (this.#state === "closing") return undefined;
    if (this.#writeWait === "drain" && this.#sendQueue.length > 0) return undefined;
    if (this.#state === "open" && this.#maxQueueBytes - this.#sendBytes >= this.#maxFrameBytes) {
      return { bytes: BigInt(this.#maxFrameBytes) };
    }
    if (this.#state === "closed") {
      return { bytes: 0n, hangup: true };
    }
    return undefined;
  }

  subscribe(direction: Direction, notify: () => void): () => void {
    if (this.#disposed) {
      notify();
      return () => {};
    }
    const listeners = this.#subscribers[direction];
    listeners.add(notify);
    // KernelDescriptors checks readiness both before and after subscribing.
    if (this.ready(direction) !== undefined) this.#notifyOne(notify);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      listeners.delete(notify);
    };
  }

  canSend(): number {
    if (this.#state === "closed" || this.#state === "closing" || this.#fatalErrno !== undefined) {
      return WS_ERRNO.EPIPE;
    }
    if (this.#state !== "open" || this.#maxQueueBytes - this.#sendBytes < this.#maxFrameBytes) {
      return WS_ERRNO.EAGAIN;
    }
    return 0;
  }

  send(opcode: number, data: Uint8Array): number {
    if (opcode !== 1 && opcode !== 2) {
      return opcode === 8 || opcode === 9 || opcode === 10 ? WS_ERRNO.ENOTSUP : WS_ERRNO.EINVAL;
    }
    if (data.byteLength > this.#maxFrameBytes) return WS_ERRNO.EMSGSIZE;
    if (opcode === 1) {
      try {
        decodeTextFrame(data);
      } catch {
        return WS_ERRNO.EINVAL;
      }
    }
    if (this.#state === "closed" || this.#state === "closing" || this.#fatalErrno !== undefined) {
      return WS_ERRNO.EPIPE;
    }
    if (this.#state !== "open") return WS_ERRNO.EAGAIN;
    const charge = queueCharge(data.byteLength);
    if (this.#sendBytes + charge > this.#maxQueueBytes) return WS_ERRNO.EAGAIN;

    this.#sendQueue.push({ opcode, data: data.slice(), charge });
    this.#sendBytes += charge;
    this.#scheduleDrain();
    return 0;
  }

  flush(): number {
    if (this.#sendQueue.length === 0) return this.#fatalErrno ?? 0;
    this.#writeWait ??= "drain";
    return WS_ERRNO.EAGAIN;
  }

  closeGracefully(): number {
    if (this.#state === "closed") return 0;
    if (!this.#closeRequested) {
      const wasConnecting = this.#state === "connecting";
      this.#closeRequested = true;
      this.#state = "closing";
      this.#writeWait = "close";
      this.#notifyBoth();
      if (wasConnecting) this.#abort.abort();
      if (this.#socket === undefined && this.#handshake === undefined) this.#abort.abort();
      this.#closeNativeWhenDrained();
    }
    return this.#closeResult();
  }

  /** Called only after the final descriptor alias is released. */
  close(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#state = "closed";
    this.#abort.abort();
    this.#receiveQueue.length = 0;
    this.#sendQueue.length = 0;
    this.#receiveBytes = 0;
    this.#sendBytes = 0;
    this.#writeWait = undefined;
    this.#handshake = undefined;
    this.#handshakeError = undefined;
    this.#detachSocket(true);
    this.#notifyBoth();
    this.#subscribers.read.clear();
    this.#subscribers.write.clear();
  }

  #attach(socket: KernelWebSocketWebSocket): void {
    this.#socket = socket;
    socket.binaryType = "arraybuffer";
    const add = (type: string, listener: EventListener) => {
      this.#socketListeners.push([type, listener]);
      socket.addEventListener(type, listener);
    };
    add("open", () => this.#onOpen());
    add("message", (event) => this.#onMessage(event as MessageEvent));
    add("close", (event) => this.#onClose(event as CloseEvent));
    add("error", () => this.#onError());

    if (socket.readyState === OPEN) this.#onOpen();
    else if (socket.readyState === CLOSING || socket.readyState === CLOSED) this.#onClose();
  }

  #onOpen(): void {
    if (this.#disposed || this.#state === "closed") return;
    if (this.#closeRequested) {
      this.#state = "closing";
      this.#closeNativeWhenDrained();
    } else {
      this.#state = "open";
      this.#notify("write");
    }
  }

  #onMessage(event: MessageEvent): void {
    if (this.#disposed || this.#state === "closing" || this.#state === "closed") return;
    const data = event.data;
    if (typeof data === "string") {
      this.#enqueueReceived(1, new TextEncoder().encode(data));
      return;
    }
    if (isArrayBuffer(data)) {
      this.#enqueueReceived(2, new Uint8Array(data));
      return;
    }
    if (ArrayBuffer.isView(data)) {
      this.#enqueueReceived(2, new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      return;
    }
    if (typeof Blob !== "undefined" && data instanceof Blob) {
      void data
        .arrayBuffer()
        .then((buffer) => this.#enqueueReceived(2, new Uint8Array(buffer)))
        .catch(() => this.#fail(WS_ERRNO.EIO));
      return;
    }
    this.#fail(WS_ERRNO.EIO);
  }

  #enqueueReceived(opcode: number, data: Uint8Array): void {
    if (this.#disposed || this.#state === "closing" || this.#state === "closed") return;
    if (data.byteLength > this.#maxFrameBytes) {
      this.#fail(WS_ERRNO.EMSGSIZE);
      return;
    }
    const charge = queueCharge(data.byteLength);
    if (this.#receiveBytes + charge > this.#maxQueueBytes) {
      this.#fail(WS_ERRNO.EMSGSIZE);
      return;
    }
    this.#receiveQueue.push({
      id: ++this.#nextFrameId,
      opcode,
      data: data.slice(),
      charge,
    });
    this.#receiveBytes += charge;
    this.#notify("read");
  }

  #onClose(event?: CloseEvent): void {
    if (this.#disposed || this.#state === "closed") return;
    this.#state = "closed";
    this.#writeWait = undefined;
    this.#sendQueue.length = 0;
    this.#sendBytes = 0;
    if (event !== undefined) {
      const payload = closePayload(event.code, event.reason ?? "");
      if (payload === undefined) this.#fatalErrno ??= WS_ERRNO.EIO;
      else if (payload.byteLength <= this.#maxFrameBytes) this.#enqueueClosedFrame(payload);
      else this.#fatalErrno = WS_ERRNO.EMSGSIZE;
    }
    this.#detachSocket(false);
    this.#notifyBoth();
  }

  #enqueueClosedFrame(payload: Uint8Array): void {
    const charge = queueCharge(payload.byteLength);
    if (this.#receiveBytes + charge > this.#maxQueueBytes) {
      this.#fatalErrno = WS_ERRNO.EMSGSIZE;
      return;
    }
    this.#receiveQueue.push({ id: ++this.#nextFrameId, opcode: 8, data: payload, charge });
    this.#receiveBytes += charge;
  }

  #onError(): void {
    this.#fail(WS_ERRNO.EIO);
  }

  #fail(errno: number): void {
    if (this.#disposed || this.#state === "closed") return;
    this.#fatalErrno ??= errno;
    this.#closeRequested = true;
    this.#state = "closing";
    this.#writeWait = "close";
    this.#closeNativeWhenDrained();
    this.#notifyBoth();
  }

  #scheduleDrain(): void {
    if (this.#drainScheduled) return;
    this.#drainScheduled = true;
    queueMicrotask(() => this.#drainSendQueue());
  }

  #drainSendQueue(): void {
    this.#drainScheduled = false;
    if (this.#disposed) return;
    const socket = this.#socket;
    if (socket === undefined || this.#state === "connecting") return;
    while (this.#sendQueue.length > 0 && this.#state !== "closed") {
      const frame = this.#sendQueue[0]!;
      try {
        socket.send(frame.opcode === 1 ? decodeTextFrame(frame.data) : frame.data);
      } catch {
        this.#sendQueue.length = 0;
        this.#sendBytes = 0;
        this.#fail(WS_ERRNO.EIO);
        return;
      }
      this.#sendQueue.shift();
      this.#sendBytes -= frame.charge;
    }
    const drainedWait = this.#writeWait === "drain" && this.#sendQueue.length === 0;
    if (drainedWait) this.#writeWait = undefined;
    if (drainedWait || (this.#state === "open" && this.ready("write") !== undefined)) {
      this.#notify("write");
    }
    this.#closeNativeWhenDrained();
  }

  #closeNativeWhenDrained(): void {
    if (!this.#closeRequested || this.#sendQueue.length > 0 || this.#nativeCloseRequested) return;
    if (this.#socket === undefined) return;
    this.#nativeCloseRequested = true;
    try {
      if (this.#socket.readyState === OPEN || this.#socket.readyState === CONNECTING) {
        this.#socket.close(this.#fatalErrno === WS_ERRNO.EMSGSIZE ? 1009 : 1000, "");
      } else if (this.#socket.readyState === CLOSED) {
        this.#onClose();
      }
    } catch {
      this.#onClose();
    }
  }

  #closeSocket(socket: KernelWebSocketWebSocket | undefined): void {
    if (socket === undefined) return;
    try {
      if (socket.readyState === OPEN || socket.readyState === CONNECTING) socket.close(1000, "");
    } catch {
      // The resource is already abandoned; native close can fail during teardown.
    }
  }

  #detachSocket(closeSocket: boolean): void {
    const socket = this.#socket;
    this.#socket = undefined;
    for (const [type, listener] of this.#socketListeners.splice(0)) {
      try {
        socket?.removeEventListener(type, listener);
      } catch {
        // Cleanup must not retain the resource through native event listeners.
      }
    }
    if (closeSocket) this.#closeSocket(socket);
  }

  #notifyBoth(): void {
    this.#notify("read");
    this.#notify("write");
  }

  #notify(direction: Direction): void {
    // eslint-disable-next-line unicorn/no-useless-spread -- A wake may subscribe again during delivery.
    for (const notify of [...this.#subscribers[direction]]) this.#notifyOne(notify);
  }

  #notifyOne(notify: () => void): void {
    try {
      notify();
    } catch {
      // A poller owns its own notification errors.
    }
  }

  #closeResult(): number {
    return this.#state === "closed" ? 0 : WS_ERRNO.EAGAIN;
  }
}

export function queueCharge(length: number): number {
  return Math.max(1, length);
}

function isArrayBuffer(value: unknown): value is ArrayBuffer {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.prototype.toString.call(value) === "[object ArrayBuffer]"
  );
}

function decodeTextFrame(data: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
}

function closePayload(code: number | undefined, reason: string): Uint8Array | undefined {
  if (code === 1005) return new Uint8Array();
  if (code === 1006 || code === 1015) return undefined;
  if (!Number.isInteger(code) || code! < 1000 || code! >= 5000 || code === 1004) {
    return undefined;
  }

  const reasonBytes = new TextEncoder().encode(reason);
  const payload = new Uint8Array(2 + reasonBytes.byteLength);
  new DataView(payload.buffer).setUint16(0, code!, false);
  payload.set(reasonBytes, 2);
  return payload;
}
