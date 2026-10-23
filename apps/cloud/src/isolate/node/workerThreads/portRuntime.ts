import { decodeWorkerMessage, encodeWorkerMessage } from "./messageCodec.ts";
import type { WorkerMessagePortHandle } from "./messageCodec.ts";
import { NodeWorkerMessagePort } from "./ports.ts";
import { dataCloneError, getPortState, hasPortState } from "./portState.ts";
import type { NodeWorkerPortRuntime } from "./portState.ts";
import type {
  NodeWorkerMessage,
  NodeWorkerPortAddress,
  NodeWorkerPortConnection,
  NodeWorkerPortEvent,
  NodeWorkerPortReceiver,
} from "./protocol.ts";

export interface NodeWorkerPortContext {
  readonly owner: string;
  readonly connect: (receiver: NodeWorkerPortReceiver) => Promise<NodeWorkerPortConnection>;
  readonly disconnect: () => Promise<void>;
  readonly onReferenceChange?: () => void;
}

const noFailure = Symbol("no worker port failure");

function addressFrom(value: unknown): NodeWorkerPortAddress {
  if (value === null || typeof value !== "object")
    throw dataCloneError("MessagePort address is invalid");
  const id = Reflect.get(value, "id");
  const lease = Reflect.get(value, "lease");
  if (typeof id !== "string" || id.length === 0 || typeof lease !== "string" || lease.length === 0)
    throw dataCloneError("MessagePort address is invalid");
  return { id, lease };
}

function addressIsTransfer(value: unknown): value is NodeWorkerMessagePort {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    hasPortState(value)
  );
}

export class NodeWorkerPorts implements NodeWorkerPortRuntime {
  readonly #context: NodeWorkerPortContext;
  readonly #sharedMemory: "same-isolate" | undefined;
  readonly #ports = new Map<string, NodeWorkerMessagePort>();
  readonly #staleLeases = new Map<string, Set<string>>();
  readonly #connection: Promise<NodeWorkerPortConnection>;
  readonly #failed = Promise.withResolvers<never>();
  #failure: unknown = noFailure;
  #tail = Promise.resolve();
  #sequence = 0;
  #disposed = false;
  #disposePromise: Promise<void> | undefined;

  constructor(
    context: NodeWorkerPortContext,
    options: Readonly<{ sharedMemory?: "same-isolate" }> = {},
  ) {
    if (context.owner.length === 0) throw new TypeError("Worker port owner must not be empty");
    this.#context = context;
    this.#sharedMemory = options.sharedMemory;
    void this.#failed.promise.catch(() => undefined);
    try {
      this.#connection = Promise.resolve(
        context.connect({
          receive: async (event) => {
            try {
              return this.#receive(event);
            } catch (error) {
              this.#recordFailure(error);
              throw error;
            }
          },
        }),
      );
    } catch (error) {
      this.#connection = Promise.reject(error);
    }
    void this.#connection.catch((error: unknown) => this.#recordFailure(error));
  }

  get failure(): Promise<never> {
    return this.#failed.promise;
  }

  get referenced(): boolean {
    return [...this.#ports.values()].some((port) => {
      const current = getPortState(port);
      return current.started && port.hasRef();
    });
  }

  channel(): { port1: NodeWorkerMessagePort; port2: NodeWorkerMessagePort } {
    if (this.#disposed) throw new Error("Worker port owner is closed");
    const first = this.#address();
    const second = this.#address();
    const [port1, port2] = this.#install([first, second]);
    this.enqueue((connection) => connection.open(first, second));
    return { port1: port1!, port2: port2! };
  }

  adopt(address: NodeWorkerPortAddress): NodeWorkerMessagePort {
    const [port] = this.#install([address]);
    return port!;
  }

  encode(value: unknown, transferList?: readonly unknown[]): NodeWorkerMessage {
    if (this.#disposed) throw new Error("Worker port owner is closed");
    return encodeWorkerMessage(value, {
      ports: {
        isPort: (entry): entry is NodeWorkerMessagePort => addressIsTransfer(entry),
        prepareTransfer: (port: NodeWorkerMessagePort) => {
          const current = getPortState(port);
          if (current.runtime !== this || current.detached || current.closed)
            throw dataCloneError("MessagePort is already detached");
          const handle: WorkerMessagePortHandle & { readonly previousLease: string } = {
            id: current.address.id,
            lease: `${this.#context.owner}/${++this.#sequence}`,
            previousLease: current.address.lease,
          };
          let committed = false;
          return {
            handle,
            commit: () => {
              if (committed) return;
              committed = true;
              current.detached = true;
              current.closed = true;
              current.started = false;
              current.referenced = false;
              this.#ports.delete(current.address.id);
              this.retire(current.address);
              this.referencesChanged();
              try {
                queueMicrotask(() => this.#emitClose(port));
              } catch (error) {
                this.#recordFailure(error);
              }
            },
          };
        },
      },
      ...(this.#sharedMemory === undefined ? {} : { sharedMemory: this.#sharedMemory }),
      ...(transferList === undefined ? {} : { transfer: transferList }),
    });
  }

  decode(message: NodeWorkerMessage): unknown {
    return decodeWorkerMessage(message, {
      adoptTransfers: (handles) => {
        const addresses: NodeWorkerPortAddress[] = [];
        for (const handle of handles) {
          const previousLease = Reflect.get(handle, "previousLease");
          if (typeof previousLease !== "string" || previousLease.length === 0)
            throw dataCloneError("MessagePort transfer lease is invalid");
          addresses.push(addressFrom(handle));
        }
        return this.#install(addresses);
      },
    });
  }

  enqueue(operation: (connection: NodeWorkerPortConnection) => Promise<void>): void {
    const next = this.#tail.then(async () => operation(await this.#connection));
    this.#tail = next.then(
      () => undefined,
      (error: unknown) => this.#recordFailure(error),
    );
  }

  async drain(): Promise<void> {
    await this.#connection;
    await this.#tail;
    if (this.#failure !== noFailure) throw this.#failure;
  }

  dispose(): Promise<void> {
    if (this.#disposePromise !== undefined) return this.#disposePromise;
    this.#disposed = true;
    this.#disposePromise = this.#dispose();
    return this.#disposePromise;
  }

  referencesChanged(): void {
    try {
      this.#context.onReferenceChange?.();
    } catch (error) {
      this.#recordFailure(error);
    }
  }

  reportFailure(error: unknown): void {
    this.#recordFailure(error);
  }

  retire(address: NodeWorkerPortAddress): void {
    let leases = this.#staleLeases.get(address.id);
    if (leases === undefined) {
      leases = new Set();
      this.#staleLeases.set(address.id, leases);
    }
    leases.add(address.lease);
  }

  #install(addresses: readonly NodeWorkerPortAddress[]): NodeWorkerMessagePort[] {
    if (this.#disposed) throw new Error("Worker port owner is closed");
    const checked: NodeWorkerPortAddress[] = [];
    const ids = new Set<string>();
    for (const input of addresses) {
      const address = addressFrom(input);
      if (ids.has(address.id) || this.#ports.has(address.id))
        throw dataCloneError("MessagePort transfer is duplicated");
      if (this.#staleLeases.get(address.id)?.has(address.lease))
        throw dataCloneError("MessagePort transfer lease is stale");
      ids.add(address.id);
      checked.push(address);
    }
    const ports = checked.map((address) => new NodeWorkerMessagePort(this, address));
    for (let index = 0; index < ports.length; index++)
      this.#ports.set(checked[index]!.id, ports[index]!);
    return ports;
  }

  #receive(event: NodeWorkerPortEvent): boolean {
    const port = this.#ports.get(event.port.id);
    if (port === undefined) return false;
    const current = getPortState(port);
    if (current.detached || current.address.lease !== event.port.lease) return false;
    if (event.type === "close") {
      current.closed = true;
      current.started = false;
      current.referenced = false;
      this.#ports.delete(event.port.id);
      this.retire(current.address);
      this.#emitClose(port);
      this.referencesChanged();
      return true;
    }
    const value = this.decode(event.message);
    const ports = event.message.ports.map(({ handle }) => {
      const port = this.#ports.get(handle.id);
      if (port === undefined || getPortState(port).address.lease !== handle.lease)
        throw dataCloneError("MessagePort transfer was not adopted");
      return port;
    });
    const message = new MessageEvent("message", { data: value });
    // Node's constructor brand-checks native ports, while this facade exposes its adopted ports.
    Object.defineProperty(message, "ports", { enumerable: true, value: ports });
    port.emit("message", value);
    port.dispatchEvent(message);
    this.referencesChanged();
    return true;
  }

  #emitClose(port: NodeWorkerMessagePort): void {
    const current = getPortState(port);
    if (current.closeEmitted) return;
    current.closeEmitted = true;
    port.emit("close");
    port.dispatchEvent(new Event("close"));
  }

  async #dispose(): Promise<void> {
    let failure = this.#failure;
    try {
      await this.#tail;
    } catch (error) {
      failure = failure === noFailure ? error : failure;
      this.#recordFailure(error);
    }
    try {
      await this.#context.disconnect();
    } catch (error) {
      failure = failure === noFailure ? error : failure;
      this.#recordFailure(error);
    }
    for (const port of this.#ports.values()) {
      const current = getPortState(port);
      current.closed = true;
      current.started = false;
      current.referenced = false;
      this.retire(current.address);
    }
    this.#ports.clear();
    this.#staleLeases.clear();
    this.referencesChanged();
    if (failure === noFailure) failure = this.#failure;
    if (failure !== noFailure) throw failure;
  }

  #address(): NodeWorkerPortAddress {
    return {
      id: `${this.#context.owner}/${++this.#sequence}`,
      lease: `${this.#context.owner}/${++this.#sequence}`,
    };
  }

  #recordFailure(error: unknown): void {
    if (this.#failure !== noFailure) return;
    this.#failure = error;
    this.#failed.reject(error);
  }
}
