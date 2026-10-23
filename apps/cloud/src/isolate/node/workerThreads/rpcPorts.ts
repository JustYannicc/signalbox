import { RpcTarget, type RpcStub } from "cloudflare:workers";
import { NodeWorkerPortBroker } from "./portBroker.ts";
import type { NodeWorkerPortContext } from "./portRuntime.ts";
import type {
  NodeWorkerMessage,
  NodeWorkerPortAddress,
  NodeWorkerPortConnection,
  NodeWorkerPortEvent,
  NodeWorkerPortReceiver,
} from "./protocol.ts";

interface PortReceiver extends RpcTarget, NodeWorkerPortReceiver {}

class PortConnection extends RpcTarget implements NodeWorkerPortConnection {
  readonly #connection: NodeWorkerPortConnection;

  constructor(connection: NodeWorkerPortConnection) {
    super();
    this.#connection = connection;
  }

  open(first: NodeWorkerPortAddress, second: NodeWorkerPortAddress) {
    return this.#connection.open(first, second);
  }

  post(port: NodeWorkerPortAddress, message: NodeWorkerMessage) {
    return this.#connection.post(port, message);
  }

  start(port: NodeWorkerPortAddress) {
    return this.#connection.start(port);
  }

  close(port: NodeWorkerPortAddress) {
    return this.#connection.close(port);
  }
}

interface OwnerBinding {
  readonly owner: string;
  receiver: RpcStub<PortReceiver> | undefined;
  active: boolean;
}

export interface NodeWorkerPortOwner extends RpcTarget {
  connect(receiver: RpcStub<PortReceiver>): PortConnection;
  disconnect(): Promise<void>;
}

class PortOwner extends RpcTarget implements NodeWorkerPortOwner {
  readonly #binding: OwnerBinding;
  readonly #broker: NodeWorkerPortBroker;

  constructor(binding: OwnerBinding, broker: NodeWorkerPortBroker) {
    super();
    this.#binding = binding;
    this.#broker = broker;
  }

  connect(receiver: RpcStub<PortReceiver>) {
    const binding = this.#binding;
    if (!binding.active || binding.receiver !== undefined)
      throw new Error("Worker port owner is already connected or closed");
    // Incoming RPC arguments expire at return. The process lease owns this duplicate.
    const held = receiver.dup();
    try {
      const connection = this.#broker.connect(binding.owner, held);
      binding.receiver = held;
      return new PortConnection(connection);
    } catch (error) {
      held[Symbol.dispose]();
      throw error;
    }
  }

  disconnect() {
    this.#binding.active = false;
    return this.#broker.disconnect(this.#binding.owner);
  }
}

/** The supervisor creates one capability per process lease, never per Node thread ID. */
export class NodeWorkerPortService {
  readonly #broker = new NodeWorkerPortBroker();
  readonly #owners = new Map<string, OwnerBinding>();
  #disposed = false;
  #disposal: Promise<void> | undefined;

  owner(owner: string): NodeWorkerPortOwner {
    if (this.#disposed || !owner || this.#owners.has(owner))
      throw new Error("Worker port owner is already reserved or closed");
    const binding: OwnerBinding = { owner, receiver: undefined, active: true };
    this.#owners.set(owner, binding);
    return new PortOwner(binding, this.#broker);
  }

  transfer(from: string, to: string, message: NodeWorkerMessage) {
    return this.#broker.transfer(from, to, message);
  }

  get failure() {
    return this.#broker.failure;
  }

  get residentPorts() {
    return this.#broker.residentPorts;
  }

  async drain() {
    try {
      await this.#broker.drain();
    } finally {
      // Closing a channel does not acknowledge a process stop. It only fences its callbacks.
      for (const binding of this.#owners.values()) {
        if (!binding.active) {
          binding.receiver?.[Symbol.dispose]();
          binding.receiver = undefined;
        }
      }
    }
  }

  dispose(): Promise<void> {
    if (this.#disposal !== undefined) return this.#disposal;
    this.#disposed = true;
    this.#disposal = (async () => {
      for (const binding of this.#owners.values()) {
        binding.active = false;
        await this.#broker.disconnect(binding.owner);
      }
      try {
        await this.drain();
      } finally {
        this.#owners.clear();
      }
    })();
    return this.#disposal;
  }
}

class Receiver extends RpcTarget implements NodeWorkerPortReceiver {
  readonly #receiver: NodeWorkerPortReceiver;

  constructor(receiver: NodeWorkerPortReceiver) {
    super();
    this.#receiver = receiver;
  }

  receive(event: NodeWorkerPortEvent) {
    return this.#receiver.receive(event);
  }
}

/** Bind the remote owner before the receiving start call releases its RPC arguments. */
export function createNodeWorkerPortContext(
  owner: string,
  remote: RpcStub<NodeWorkerPortOwner>,
  onReferenceChange?: () => void,
): NodeWorkerPortContext {
  const held = remote.dup();
  let connection: Promise<RpcStub<PortConnection>> | undefined;
  let disposal: Promise<void> | undefined;
  return {
    owner,
    ...(onReferenceChange === undefined ? {} : { onReferenceChange }),
    connect(receiver) {
      if (connection !== undefined || disposal !== undefined)
        throw new Error("Worker port context is already connected or closed");
      connection = held.connect(new Receiver(receiver));
      return connection;
    },
    disconnect() {
      if (disposal !== undefined) return disposal;
      disposal = (async () => {
        let connected: RpcStub<PortConnection> | undefined;
        const failures: unknown[] = [];
        try {
          connected = await connection;
        } catch (error) {
          failures.push(error);
        }
        try {
          await held.disconnect();
        } catch (error) {
          failures.push(error);
        } finally {
          connected?.[Symbol.dispose]();
          held[Symbol.dispose]();
        }
        if (failures.length > 0)
          throw new AggregateError(failures, "Worker port disconnect failed");
      })();
      return disposal;
    },
  };
}
