import type {
  NodeWorkerMessage,
  NodeWorkerPortAddress,
  NodeWorkerPortConnection,
  NodeWorkerPortReceiver,
} from "./protocol.ts";

interface Port {
  address: NodeWorkerPortAddress;
  owner: string;
  peer: string | undefined;
  started: boolean;
  closed: boolean;
  readonly pending: NodeWorkerMessage[];
  delivering: NodeWorkerMessage | undefined;
  pumping: Promise<void> | undefined;
}

interface Owner {
  readonly receiver: NodeWorkerPortReceiver;
  active: boolean;
}

/** Port identities outlive their creating process when another process owns them. */
export class NodeWorkerPortBroker {
  readonly #ports = new Map<string, Port>();
  readonly #owners = new Map<string, Owner>();
  readonly #pumps = new Set<Promise<void>>();
  readonly #failed = Promise.withResolvers<never>();
  #failure: unknown;

  constructor() {
    void this.#failed.promise.catch(() => undefined);
  }

  get failure(): Promise<never> {
    return this.#failed.promise;
  }

  connect(owner: string, receiver: NodeWorkerPortReceiver): NodeWorkerPortConnection {
    if (!owner || this.#owners.has(owner))
      throw new Error("Worker port owner is already connected");
    const binding = { receiver, active: true };
    this.#owners.set(owner, binding);
    const run = <T>(operation: () => Promise<T> | T) => {
      try {
        if (!binding.active) throw new Error("Worker port owner is closed");
        return Promise.resolve(operation());
      } catch (error) {
        return Promise.reject(error);
      }
    };
    return {
      open: (first, second) =>
        run(() => {
          if (!first.id.startsWith(`${owner}/`) || !second.id.startsWith(`${owner}/`))
            throw new Error("Worker port identity belongs to another process");
          if (
            !first.lease ||
            !second.lease ||
            first.id === second.id ||
            this.#ports.has(first.id) ||
            this.#ports.has(second.id)
          )
            throw new Error("Worker port identity is already in use");
          for (const [address, peer] of [
            [first, second],
            [second, first],
          ] as const)
            this.#ports.set(address.id, {
              address,
              owner,
              peer: peer.id,
              started: false,
              closed: false,
              pending: [],
              delivering: undefined,
              pumping: undefined,
            });
        }),
      post: (address, message) =>
        run(() => {
          const source = this.#owned(owner, address);
          if (source.closed || source.peer === undefined) return;
          const destination = this.#ports.get(source.peer);
          if (destination === undefined || destination.closed) return;
          this.#move(owner, destination.owner, message);
          destination.pending.push(message);
          this.#schedule(destination);
        }),
      start: (address) =>
        run(() => {
          const port = this.#owned(owner, address);
          if (port.closed) return;
          port.started = true;
          this.#schedule(port);
        }),
      close: (address) => run(() => this.#close(this.#owned(owner, address))),
    };
  }

  /** The supervisor uses the same transfer transaction for a worker's initial data. */
  transfer(from: string, to: string, message: NodeWorkerMessage): Promise<void> {
    return Promise.resolve().then(() => {
      if (!this.#owners.get(from)?.active || !this.#owners.get(to)?.active)
        throw new Error("Worker port transfer owner is closed");
      this.#move(from, to, message);
    });
  }

  disconnect(owner: string): Promise<void> {
    return Promise.resolve().then(() => {
      const binding = this.#owners.get(owner);
      if (binding === undefined) return;
      binding.active = false;
      for (const port of this.#ports.values())
        if (port.owner === owner && !port.closed) this.#close(port);
      this.#owners.delete(owner);
    });
  }

  async drain(): Promise<void> {
    while (this.#pumps.size > 0) await Promise.allSettled(this.#pumps);
    if (this.#failure !== undefined) throw this.#failure;
  }

  get residentPorts(): number {
    return this.#ports.size;
  }

  #owned(owner: string, address: NodeWorkerPortAddress): Port {
    const port = this.#ports.get(address.id);
    if (port === undefined || port.owner !== owner || port.address.lease !== address.lease)
      throw new Error("Worker port lease is stale");
    return port;
  }

  #move(from: string, to: string, message: NodeWorkerMessage): void {
    const moving = new Set<string>();
    const ports = message.ports.map(({ handle }) => {
      const port = this.#ports.get(handle.id);
      if (
        port === undefined ||
        port.closed ||
        port.owner !== from ||
        !handle.lease ||
        handle.previousLease !== port.address.lease ||
        handle.lease === port.address.lease ||
        moving.has(handle.id)
      )
        throw new Error("Worker port transfer lease is invalid");
      moving.add(handle.id);
      return { port, handle };
    });
    const nested = new Set<Port>();
    for (const { port } of ports) this.#collectPending(port, from, nested);
    for (const { port, handle } of ports) {
      port.address = { id: handle.id, lease: handle.lease };
      port.owner = to;
      port.started = false;
    }
    for (const port of nested) port.owner = to;
  }

  #collectMessage(message: NodeWorkerMessage, owner: string, nested: Set<Port>): void {
    for (const { handle } of message.ports) {
      const port = this.#ports.get(handle.id);
      if (port === undefined || port.owner !== owner || port.address.lease !== handle.lease)
        throw new Error("Queued worker port transfer is stale");
      if (nested.has(port)) continue;
      nested.add(port);
      this.#collectPending(port, owner, nested);
    }
  }

  #collectPending(port: Port, owner: string, nested: Set<Port>): void {
    for (const message of port.pending)
      if (message !== port.delivering) this.#collectMessage(message, owner, nested);
  }

  #close(port: Port): void {
    if (port.closed) return;
    port.closed = true;
    const peer = port.peer === undefined ? undefined : this.#ports.get(port.peer);
    port.peer = undefined;
    if (peer !== undefined) {
      peer.peer = undefined;
      peer.closed = true;
      this.#schedule(peer);
    }
    this.#schedule(port);
  }

  #schedule(port: Port): void {
    if (port.pumping !== undefined) return;
    let completed = false;
    // No broker lock or process admission is held while another process handles a message.
    const pumping = Promise.resolve()
      .then(async () => {
        while (port.started && port.pending.length > 0) {
          const owner = this.#owners.get(port.owner);
          const message = port.pending[0];
          if (owner === undefined || !owner.active || message === undefined) break;
          const address = port.address;
          const receivingOwner = port.owner;
          port.delivering = message;
          const accepted = await owner.receiver.receive({
            type: "message",
            port: address,
            message,
          });
          port.delivering = undefined;
          if (accepted) port.pending.shift();
          else if (address.lease === port.address.lease)
            throw new Error("Worker port receiver rejected its current lease");
          else {
            const nested = new Set<Port>();
            this.#collectMessage(message, receivingOwner, nested);
            for (const transferred of nested) transferred.owner = port.owner;
          }
        }
        if (port.closed) {
          port.pending.length = 0;
          const owner = this.#owners.get(port.owner);
          if (owner?.active) await owner.receiver.receive({ type: "close", port: port.address });
          this.#ports.delete(port.address.id);
        }
        completed = true;
      })
      .finally(() => {
        port.pumping = undefined;
        this.#pumps.delete(pumping);
        if (
          completed &&
          this.#ports.get(port.address.id) === port &&
          (port.closed || (port.started && port.pending.length > 0))
        )
          this.#schedule(port);
      });
    port.pumping = pumping;
    this.#pumps.add(pumping);
    void pumping.catch((error: unknown) => {
      this.#failure = error;
      this.#failed.reject(error);
    });
  }
}
