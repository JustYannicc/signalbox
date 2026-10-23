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
  peerClosed: boolean;
  readonly pending: NodeWorkerMessage[];
  readonly pendingTransfers: Map<NodeWorkerMessage, PendingTransfers>;
  queuePins: number;
  delivering: NodeWorkerMessage | undefined;
  pumping: Promise<void> | undefined;
}

interface TransferLease {
  owner: string;
  readonly lease: string;
}

type PendingTransfers = Map<Port, TransferLease>;

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
              peerClosed: false,
              pending: [],
              pendingTransfers: new Map(),
              queuePins: 0,
              delivering: undefined,
              pumping: undefined,
            });
        }),
      post: (address, message) =>
        run(() => {
          const source = this.#owned(owner, address);
          if (source.closed || source.peerClosed || source.peer === undefined) return;
          const destination = this.#ports.get(source.peer);
          if (destination === undefined || destination.closed) return;
          this.#move(owner, destination.owner, message);
          destination.pendingTransfers.set(message, this.#pinTransfers(message, destination.owner));
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
        if (port.owner === owner && !port.closed && port.queuePins === 0) this.#close(port);
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
    const movedPorts = new Set([...ports.map(({ port }) => port), ...nested]);
    this.#retargetPendingTransferOwners(movedPorts, from, to);
  }

  #pinTransfers(message: NodeWorkerMessage, owner: string): PendingTransfers {
    const ports = new Set<Port>();
    this.#collectMessage(message, owner, ports);
    const transfers: PendingTransfers = new Map();
    for (const port of ports) {
      transfers.set(port, { owner, lease: port.address.lease });
      port.queuePins++;
    }
    return transfers;
  }

  #retargetTransfers(transfers: PendingTransfers, from: string, to: string): void {
    for (const [port, lease] of transfers)
      if (
        lease.owner !== from ||
        port.owner !== from ||
        port.address.lease !== lease.lease ||
        this.#ports.get(port.address.id) !== port
      )
        throw new Error("Queued worker port transfer changed during delivery");
    // The queue can grow through a peer while this packet's receiver awaits its ACK.
    const unreadDescendants = new Set<Port>();
    for (const port of transfers.keys()) this.#collectPending(port, from, unreadDescendants);
    const retargeted = new Set([...transfers.keys(), ...unreadDescendants]);
    // Late descendants keep the pins already owned by their own queued packets.
    for (const [port, lease] of transfers) {
      port.owner = to;
      lease.owner = to;
    }
    for (const port of unreadDescendants) port.owner = to;
    this.#retargetPendingTransferOwners(retargeted, from, to);
  }

  #retargetPendingTransferOwners(ports: ReadonlySet<Port>, from: string, to: string): void {
    for (const container of ports) {
      for (const [message, transfers] of container.pendingTransfers) {
        if (message === container.delivering) continue;
        for (const [port, lease] of transfers) {
          if (!ports.has(port)) continue;
          if (
            port.owner !== to ||
            port.address.lease !== lease.lease ||
            this.#ports.get(port.address.id) !== port
          )
            throw new Error("Queued worker port transfer changed during delivery");
          if (lease.owner === from) lease.owner = to;
          else if (lease.owner !== to)
            throw new Error("Queued worker port transfer changed during delivery");
        }
      }
    }
  }

  #closeTransfers(transfers: PendingTransfers): void {
    for (const [port, lease] of transfers)
      if (
        port.owner === lease.owner &&
        port.address.lease === lease.lease &&
        this.#ports.get(port.address.id) === port
      )
        this.#close(port);
  }

  #releaseTransfers(transfers: PendingTransfers): void {
    for (const [port] of transfers) {
      port.queuePins--;
      if (port.queuePins === 0 && port.peerClosed && port.pending.length === 0)
        this.#schedule(port);
    }
  }

  #dropPending(port: Port, message: NodeWorkerMessage): void {
    const transfers = port.pendingTransfers.get(message);
    if (transfers === undefined) return;
    this.#closeTransfers(transfers);
    port.pendingTransfers.delete(message);
    this.#releaseTransfers(transfers);
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
      peer.peerClosed = true;
      this.#schedule(peer);
    }
    this.#schedule(port);
  }

  #discardPending(port: Port): void {
    for (const message of port.pending) this.#dropPending(port, message);
    port.pending.length = 0;
    port.pendingTransfers.clear();
  }

  #schedule(port: Port): void {
    if (port.pumping !== undefined) return;
    let completed = false;
    // No broker lock or process admission is held while another process handles a message.
    const pumping = Promise.resolve()
      .then(async () => {
        while (!port.closed && port.started && port.pending.length > 0) {
          const owner = this.#owners.get(port.owner);
          const message = port.pending[0];
          if (owner === undefined || !owner.active || message === undefined) break;
          const address = port.address;
          const receivingOwner = port.owner;
          const transfers = port.pendingTransfers.get(message) ?? new Map();
          port.delivering = message;
          const accepted = await owner.receiver.receive({
            type: "message",
            port: address,
            message,
          });
          port.delivering = undefined;
          if (accepted) {
            if (port.pending[0] === message) {
              port.pending.shift();
              port.pendingTransfers.delete(message);
              if (!owner.active || this.#owners.get(receivingOwner) !== owner)
                this.#closeTransfers(transfers);
              this.#releaseTransfers(transfers);
            }
          } else if (
            !port.closed &&
            address.lease !== port.address.lease &&
            this.#ports.get(address.id) === port
          ) {
            this.#retargetTransfers(transfers, receivingOwner, port.owner);
          } else if (
            !owner.active ||
            this.#owners.get(receivingOwner) !== owner ||
            port.closed ||
            this.#ports.get(address.id) !== port
          ) {
            if (port.pending[0] === message) {
              this.#dropPending(port, message);
              port.pending.shift();
            }
          } else if (address.lease === port.address.lease) {
            throw new Error("Worker port receiver rejected its current lease");
          }
        }
        if (port.closed) {
          this.#discardPending(port);
          const owner = this.#owners.get(port.owner);
          if (owner?.active) await owner.receiver.receive({ type: "close", port: port.address });
          this.#ports.delete(port.address.id);
        } else if (port.peerClosed && port.pending.length === 0 && port.queuePins === 0) {
          const address = port.address;
          const ownerId = port.owner;
          const owner = this.#owners.get(port.owner);
          if (owner?.active) await owner.receiver.receive({ type: "close", port: address });
          if (
            this.#ports.get(address.id) === port &&
            port.owner === ownerId &&
            port.address.lease === address.lease &&
            this.#owners.get(ownerId) === owner
          )
            this.#ports.delete(address.id);
        }
        completed = true;
      })
      .finally(() => {
        port.pumping = undefined;
        this.#pumps.delete(pumping);
        if (
          completed &&
          this.#ports.get(port.address.id) === port &&
          (port.closed ||
            (port.started && port.pending.length > 0) ||
            (port.peerClosed && port.pending.length === 0 && port.queuePins === 0))
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
