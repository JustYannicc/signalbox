import * as NodeEvents from "node:events";
import type { NodeWorkerPortAddress } from "./protocol.ts";
import { dataCloneError, getPortState, registerPortState } from "./portState.ts";
import type { NodeWorkerPortRuntime } from "./portState.ts";

function transferList(
  value: readonly unknown[] | Readonly<{ transfer?: readonly unknown[] }> | undefined,
): readonly unknown[] | undefined {
  if (value === undefined || Array.isArray(value)) return value;
  if (value === null || typeof value !== "object")
    throw dataCloneError("Transfer list must be an array");
  const transfer = Reflect.get(value, "transfer");
  if (transfer === undefined) return [];
  if (!Array.isArray(transfer)) throw dataCloneError("Transfer list must be an array");
  return transfer;
}

interface WrappedEventListener {
  readonly type: string;
  readonly capture: boolean;
  readonly listener: EventListener;
}

/** A local Node-style handle; the broker owns delivery and transfer leases. */
export class NodeWorkerMessagePort extends EventTarget {
  readonly #events = new NodeEvents.EventEmitter({ captureRejections: true });
  readonly #eventWrappers = new WeakMap<
    EventListenerOrEventListenerObject,
    WrappedEventListener[]
  >();
  #onmessage: ((event: MessageEvent) => void) | null = null;
  #onmessageerror: ((event: MessageEvent) => void) | null = null;

  constructor(runtime: NodeWorkerPortRuntime, address: NodeWorkerPortAddress) {
    super();
    registerPortState(this, runtime, address);
    this.#events.on("error", (error: unknown) => runtime.reportFailure(error));
    this.#addAttributeListener("message", (event) => {
      const listener = this.#onmessage;
      if (listener !== null) this.#trackResult(listener.call(this, event as MessageEvent));
    });
    this.#addAttributeListener("messageerror", (event) => {
      const listener = this.#onmessageerror;
      if (listener !== null) this.#trackResult(listener.call(this, event as MessageEvent));
    });
  }

  postMessage(
    value: unknown,
    options?: readonly unknown[] | Readonly<{ transfer?: readonly unknown[] }>,
  ): void {
    const current = getPortState(this);
    if (current.detached || current.closed) return;
    const transfers = transferList(options);
    if (transfers?.includes(this)) throw dataCloneError("Transfer list contains source port");
    const message = current.runtime.encode(value, transfers);
    current.runtime.enqueue((connection) => connection.post(current.address, message));
  }

  start(): void {
    const current = getPortState(this);
    if (current.detached || current.closed || current.started) return;
    current.started = true;
    current.runtime.enqueue((connection) => connection.start(current.address));
    current.runtime.referencesChanged();
  }

  close(): void {
    const current = getPortState(this);
    if (current.detached || current.closed) return;
    current.closed = true;
    current.started = false;
    current.referenced = false;
    current.runtime.retire(current.address);
    current.runtime.enqueue((connection) => connection.close(current.address));
    current.runtime.referencesChanged();
  }

  ref(): this {
    const current = getPortState(this);
    if (!current.closed && !current.detached && !current.referenced) {
      current.referenced = true;
      current.runtime.referencesChanged();
    }
    return this;
  }

  unref(): this {
    const current = getPortState(this);
    if (current.referenced) {
      current.referenced = false;
      current.runtime.referencesChanged();
    }
    return this;
  }

  hasRef(): boolean {
    const current = getPortState(this);
    return current.referenced && !current.closed && !current.detached;
  }

  on(event: string | symbol, listener: (...args: unknown[]) => void): this {
    this.#events.on(event, listener);
    if (event === "message" || event === "messageerror") this.start();
    return this;
  }

  addListener(event: string | symbol, listener: (...args: unknown[]) => void): this {
    return this.on(event, listener);
  }

  once(event: string | symbol, listener: (...args: unknown[]) => void): this {
    this.#events.once(event, listener);
    if (event === "message" || event === "messageerror") this.start();
    return this;
  }

  prependListener(event: string | symbol, listener: (...args: unknown[]) => void): this {
    this.#events.prependListener(event, listener);
    if (event === "message" || event === "messageerror") this.start();
    return this;
  }

  prependOnceListener(event: string | symbol, listener: (...args: unknown[]) => void): this {
    this.#events.prependOnceListener(event, listener);
    if (event === "message" || event === "messageerror") this.start();
    return this;
  }

  off(event: string | symbol, listener: (...args: unknown[]) => void): this {
    this.#events.off(event, listener);
    return this;
  }

  removeListener(event: string | symbol, listener: (...args: unknown[]) => void): this {
    return this.off(event, listener);
  }

  removeAllListeners(event?: string | symbol): this {
    this.#events.removeAllListeners(event);
    return this;
  }

  listenerCount(event: string | symbol): number {
    return this.#events.listenerCount(event);
  }

  listeners(event: string | symbol): Function[] {
    return this.#events.listeners(event);
  }

  rawListeners(event: string | symbol): Function[] {
    return this.#events.rawListeners(event);
  }

  eventNames(): (string | symbol)[] {
    return this.#events.eventNames();
  }

  emit(event: string | symbol, ...args: unknown[]): boolean {
    return this.#events.emit(event, ...args);
  }

  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    if (listener === null) return;
    const capture = typeof options === "boolean" ? options : (options?.capture ?? false);
    const wrappers = this.#eventWrappers.get(listener) ?? [];
    let wrapper = wrappers.find(
      (entry) => entry.type === type && entry.capture === capture,
    )?.listener;
    if (wrapper === undefined) {
      wrapper = (event) => {
        try {
          const result =
            typeof listener === "function"
              ? listener.call(this, event)
              : listener.handleEvent(event);
          this.#trackResult(result);
        } catch (error) {
          getPortState(this).runtime.reportFailure(error);
        }
      };
      wrappers.push({ type, capture, listener: wrapper });
      this.#eventWrappers.set(listener, wrappers);
    }
    super.addEventListener(type, wrapper, options);
    if (type === "message" || type === "messageerror") this.start();
  }

  override removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ): void {
    if (listener === null) return;
    const capture = typeof options === "boolean" ? options : (options?.capture ?? false);
    const wrapper = this.#eventWrappers
      .get(listener)
      ?.find((entry) => entry.type === type && entry.capture === capture)?.listener;
    if (wrapper !== undefined) super.removeEventListener(type, wrapper, options);
  }

  get onmessage(): ((event: MessageEvent) => void) | null {
    return this.#onmessage;
  }

  set onmessage(listener: ((event: MessageEvent) => void) | null) {
    this.#onmessage = typeof listener === "function" ? listener : null;
    if (this.#onmessage !== null) this.start();
  }

  get onmessageerror(): ((event: MessageEvent) => void) | null {
    return this.#onmessageerror;
  }

  set onmessageerror(listener: ((event: MessageEvent) => void) | null) {
    this.#onmessageerror = typeof listener === "function" ? listener : null;
    if (this.#onmessageerror !== null) this.start();
  }

  #addAttributeListener(type: string, listener: EventListener): void {
    super.addEventListener(type, listener);
  }

  #trackResult(result: unknown): void {
    if (result !== null && (typeof result === "object" || typeof result === "function"))
      void Promise.resolve(result).catch((error: unknown) =>
        getPortState(this).runtime.reportFailure(error),
      );
  }
}
