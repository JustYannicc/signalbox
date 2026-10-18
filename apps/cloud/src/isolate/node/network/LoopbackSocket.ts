// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Node sockets need native Duplex semantics and instance-owned timeout callbacks.
import * as NodeBuffer from "node:buffer";
import * as NodeStream from "node:stream";
import { networkError } from "./errors.ts";
import { parseSocketAddress } from "./address.ts";
import type { DuplexTransport } from "./LoopbackTransport.ts";

interface SocketState {
  readonly ready: Promise<void>;
  resolveReady: () => void;
  rejectReady: (error: unknown) => void;
  readonly connectHandler: ((socket: LoopbackSocket, args: readonly unknown[]) => void) | undefined;
  readRequested: boolean;
  reader?: ReadableStreamDefaultReader<Uint8Array>;
  writer?: WritableStreamDefaultWriter<Uint8Array>;
  transportClose: (() => void | Promise<void>) | undefined;
  connecting: boolean;
  connected: boolean;
  readLoop: boolean;
  readEnded: boolean;
  localAddress: string | undefined;
  localPort: number | undefined;
  remoteAddress: string | undefined;
  remotePort: number | undefined;
  bytesRead: number;
  bytesWritten: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  timeoutMs: number;
}

const socketStates = new WeakMap<LoopbackSocket, SocketState>();
const resumeReadIfRequested = Symbol("resumeReadIfRequested");

function bytes(chunk: string | Uint8Array, encoding: BufferEncoding): Uint8Array {
  if (typeof chunk !== "string")
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  return NodeBuffer.Buffer.from(chunk, encoding);
}

export class LoopbackSocket extends NodeStream.Duplex {
  override readonly allowHalfOpen: boolean;

  constructor(
    options: {
      readonly allowHalfOpen?: boolean;
      readonly connect?: (socket: LoopbackSocket, args: readonly unknown[]) => void;
    } = {},
  ) {
    super({
      allowHalfOpen: options.allowHalfOpen ?? false,
      autoDestroy: true,
      decodeStrings: true,
    });
    this.allowHalfOpen = options.allowHalfOpen ?? false;
    let resolveReady = () => {};
    let rejectReady = (_error: unknown) => {};
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    void ready.catch(() => {});
    socketStates.set(this, {
      ready,
      resolveReady,
      rejectReady,
      connectHandler: options.connect,
      readRequested: false,
      transportClose: undefined,
      connecting: false,
      connected: false,
      readLoop: false,
      readEnded: false,
      localAddress: undefined,
      localPort: undefined,
      remoteAddress: undefined,
      remotePort: undefined,
      bytesRead: 0,
      bytesWritten: 0,
      timer: undefined,
      timeoutMs: 0,
    });
  }

  get connecting(): boolean {
    return socketStates.get(this)!.connecting;
  }

  get pending(): boolean {
    const state = socketStates.get(this)!;
    return !state.connected && !this.destroyed;
  }

  get localAddress(): string | undefined {
    return socketStates.get(this)!.localAddress;
  }

  get localPort(): number | undefined {
    return socketStates.get(this)!.localPort;
  }

  get remoteAddress(): string | undefined {
    return socketStates.get(this)!.remoteAddress;
  }

  get remotePort(): number | undefined {
    return socketStates.get(this)!.remotePort;
  }

  get remoteFamily(): string | undefined {
    return this.remoteAddress?.includes(":") ? "IPv6" : this.remoteAddress ? "IPv4" : undefined;
  }

  get bytesRead(): number {
    return socketStates.get(this)!.bytesRead;
  }

  get bytesWritten(): number {
    return socketStates.get(this)!.bytesWritten;
  }

  get bufferSize(): number {
    return this.writableLength;
  }

  get readyState(): "opening" | "open" | "readOnly" | "writeOnly" | "closed" {
    if (this.destroyed) return "closed";
    const readable = this.readable && !this.readableEnded;
    const writable = this.writable && !this.writableEnded;
    if (!readable && !writable) return "closed";
    if (!readable) return "writeOnly";
    if (!writable) return "readOnly";
    return this.connecting ? "opening" : "open";
  }

  connect(...args: unknown[]): this {
    const state = socketStates.get(this)!;
    if (!state.connectHandler) throw new TypeError("This socket cannot open a new connection");
    if (state.connected || state.connecting || this.destroyed) {
      throw networkError(
        "ERR_SOCKET_ALREADY_CONNECTED",
        "Socket is already connecting or connected",
      );
    }
    const last = args.at(-1);
    if (typeof last === "function") this.once("connect", last as (...eventArgs: unknown[]) => void);
    state.connecting = true;
    try {
      state.connectHandler(this, args);
    } catch (error) {
      failSocket(this, error);
    }
    return this;
  }

  address(): { address: string; family: string; port: number } | null {
    const state = socketStates.get(this)!;
    if (!state.localAddress || state.localPort === undefined) return null;
    return {
      address: state.localAddress,
      port: state.localPort,
      family: state.localAddress.includes(":") ? "IPv6" : "IPv4",
    };
  }

  setNoDelay(_noDelay = true): this {
    return this;
  }

  setKeepAlive(_enable = false, _initialDelay = 0): this {
    return this;
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }

  setTimeout(milliseconds: number, callback?: () => void): this {
    const state = socketStates.get(this)!;
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      throw new RangeError("Socket timeout must be a non-negative finite number");
    }
    state.timeoutMs = Math.min(milliseconds, 2_147_483_647);
    if (callback) this.once("timeout", callback);
    this.#touch();
    return this;
  }

  destroySoon(): void {
    this.end();
    this.once("finish", () => this.destroy());
  }

  override _read(): void {
    const state = socketStates.get(this)!;
    state.readRequested = true;
    this.#startReadIfRequested(state);
  }

  [resumeReadIfRequested](): void {
    this.#startReadIfRequested(socketStates.get(this)!);
  }

  #startReadIfRequested(state: SocketState): void {
    if (
      !state.readRequested ||
      !state.reader ||
      state.readLoop ||
      state.readEnded ||
      this.destroyed
    )
      return;
    state.readRequested = false;
    state.readLoop = true;
    void this.#pump(state);
  }

  override _write(
    chunk: string | Uint8Array,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const state = socketStates.get(this)!;
    const payload = bytes(chunk, encoding);
    void state.ready
      .then(() => {
        if (this.destroyed || !state.writer)
          throw networkError("ERR_SOCKET_CLOSED", "Socket is closed");
        return state.writer.write(payload);
      })
      .then(
        () => {
          state.bytesWritten += payload.byteLength;
          this.#touch();
          callback();
        },
        (error: unknown) => callback(error as Error),
      );
  }

  override _final(callback: (error?: Error | null) => void): void {
    const state = socketStates.get(this)!;
    void state.ready
      .then(() => state.writer?.close())
      .then(
        () => callback(),
        (error: unknown) => callback(error as Error),
      );
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    const state = socketStates.get(this)!;
    if (!state.connected && state.connecting) {
      state.connecting = false;
      state.rejectReady(error ?? networkError("ABORT_ERR", "Socket connection was cancelled"));
    }
    if (state.timer !== undefined) clearTimeout(state.timer);
    const cleanup = [
      state.reader?.cancel(error),
      state.writer?.abort(error),
      state.transportClose?.(),
    ].filter((value): value is Promise<void> => value instanceof Promise);
    void Promise.allSettled(cleanup).then(() => callback(error));
  }

  async #pump(state: SocketState): Promise<void> {
    try {
      while (!this.destroyed && state.reader) {
        const next = await state.reader.read();
        if (this.destroyed) return;
        if (next.done) {
          state.readEnded = true;
          this.push(null);
          if (!this.allowHalfOpen && !this.writableEnded) this.end();
          return;
        }
        state.bytesRead += next.value.byteLength;
        this.#touch();
        if (!this.push(next.value)) return;
      }
    } catch (error) {
      if (!this.destroyed) this.destroy(error as Error);
    } finally {
      state.readLoop = false;
      this.#startReadIfRequested(state);
    }
  }

  #touch(): void {
    const state = socketStates.get(this)!;
    if (state.timer !== undefined) clearTimeout(state.timer);
    state.timer = undefined;
    if (!state.timeoutMs || this.destroyed) return;
    state.timer = setTimeout(() => this.emit("timeout"), state.timeoutMs);
  }
}

export function attachSocketTransport(
  socket: LoopbackSocket,
  transport: DuplexTransport,
  options: { readonly emitConnect?: boolean } = {},
): void {
  const state = socketStates.get(socket)!;
  state.reader = transport.readable.getReader();
  state.writer = transport.writable.getWriter();
  state.transportClose = transport.close;
  const local = parseSocketAddress(transport.localAddress);
  const remote = parseSocketAddress(transport.remoteAddress);
  state.localAddress = local.address;
  state.localPort = local.port ?? transport.localPort;
  state.remoteAddress = remote.address;
  state.remotePort = remote.port ?? transport.remotePort;
  state.connected = true;
  state.connecting = false;
  state.resolveReady();
  void state.reader.closed.catch((error: unknown) => {
    if (!socket.destroyed) socket.destroy(error as Error);
  });
  void state.writer.closed.catch((error: unknown) => {
    if (!socket.destroyed && !socket.writableEnded) socket.destroy(error as Error);
  });
  if (options.emitConnect) {
    queueMicrotask(() => {
      if (!socket.destroyed) {
        socket.emit("connect");
        socket.emit("ready");
      }
    });
  }
  socket[resumeReadIfRequested]();
}

export function failSocket(socket: LoopbackSocket, error: unknown): void {
  const state = socketStates.get(socket)!;
  state.connecting = false;
  state.rejectReady(error);
  queueMicrotask(() => {
    if (!socket.destroyed) socket.destroy(error as Error);
  });
}
