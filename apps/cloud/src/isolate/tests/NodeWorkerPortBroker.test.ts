import { describe, expect, it } from "vite-plus/test";
import {
  NodeWorkerMessagePort,
  NodeWorkerPortBroker,
  NodeWorkerPorts,
  type NodeWorkerMessage,
  type NodeWorkerPortAddress,
  type NodeWorkerPortEvent,
  type NodeWorkerPortTransfer,
} from "../NodeWorkerThreads.ts";

const address = (id: string, lease = "first"): NodeWorkerPortAddress => ({ id, lease });
const message = (value: unknown): NodeWorkerMessage => ({ value, ports: [] });
const transfer = (address: NodeWorkerPortAddress, previousLease = "first"): NodeWorkerMessage => {
  const marker = {};
  const handle: NodeWorkerPortTransfer = { ...address, previousLease };
  return { value: { port: marker }, ports: [{ marker, handle }] };
};

function fixture() {
  const broker = new NodeWorkerPortBroker();
  const events = new Map<string, NodeWorkerPortEvent[]>();
  const connect = (owner: string) => {
    const received: NodeWorkerPortEvent[] = [];
    events.set(owner, received);
    return broker.connect(owner, {
      receive: async (event) => {
        received.push(event);
        return true;
      },
    });
  };
  return { broker, events, connect };
}

interface PublicPortsRuntime {
  readonly owner: string;
  readonly ports: NodeWorkerPorts;
}

function publicPortsRuntime(
  owner: string,
  broker: NodeWorkerPortBroker,
  beforeReceive?: (event: NodeWorkerPortEvent) => Promise<void>,
  afterReceive?: (event: NodeWorkerPortEvent, accepted: boolean) => Promise<void>,
): PublicPortsRuntime {
  return {
    owner,
    ports: new NodeWorkerPorts({
      owner,
      connect: async (receiver) =>
        broker.connect(owner, {
          receive: async (event) => {
            await beforeReceive?.(event);
            const accepted = await receiver.receive(event);
            await afterReceive?.(event, accepted);
            return accepted;
          },
        }),
      disconnect: () => broker.disconnect(owner),
    }),
  };
}

async function transferPort(
  broker: NodeWorkerPortBroker,
  source: PublicPortsRuntime,
  destination: PublicPortsRuntime,
  port: NodeWorkerMessagePort,
): Promise<NodeWorkerMessagePort> {
  const packet = source.ports.encode({ port }, [port]);
  await Promise.all([source.ports.drain(), destination.ports.drain()]);
  await broker.transfer(source.owner, destination.owner, packet);
  return (destination.ports.decode(packet) as { port: NodeWorkerMessagePort }).port;
}

describe("worker message port broker", () => {
  it("delivers ordered messages before close and releases both addresses", async () => {
    const f = fixture();
    const connection = f.connect("parent");
    const first = address("parent/a");
    const second = address("parent/b");
    await connection.open(first, second);
    await connection.start(second);
    await Promise.all([
      connection.post(first, message("one")),
      connection.post(first, message("two")),
      connection.close(first),
    ]);
    await f.broker.drain();
    expect(
      f.events
        .get("parent")
        ?.filter((event) => event.port.id === second.id)
        .map((event) => (event.type === "message" ? event.message.value : event.type)),
    ).toEqual(["one", "two", "close"]);
    expect(f.broker.residentPorts).toBe(0);
  });

  it("keeps transferred ports alive after their creating process exits", async () => {
    const f = fixture();
    const parent = f.connect("parent");
    const child = f.connect("child");
    const sibling = f.connect("sibling");
    const first = address("parent/a");
    const second = address("parent/b");
    const childPort = { ...first, lease: "child-lease" };
    const siblingPort = { ...second, lease: "sibling-lease" };
    await parent.open(first, second);
    await f.broker.transfer("parent", "child", transfer(childPort));
    await f.broker.transfer("parent", "sibling", transfer(siblingPort));
    await f.broker.disconnect("parent");
    await sibling.start(siblingPort);
    await child.post(childPort, message(new Uint8Array([0, 127, 255])));
    await f.broker.drain();
    expect(f.events.get("sibling")?.[0]).toMatchObject({
      type: "message",
      message: { value: new Uint8Array([0, 127, 255]) },
    });
    expect(f.broker.residentPorts).toBe(2);
    await child.close(childPort);
    await f.broker.drain();
    expect(f.broker.residentPorts).toBe(0);
  });

  it("delivers an unread message and transferred port before the peer close", async () => {
    const broker = new NodeWorkerPortBroker();
    const source = publicPortsRuntime("source", broker);
    const destination = publicPortsRuntime("destination", broker);
    const carrier = source.ports.channel();
    const nested = source.ports.channel();
    const receivedCarrier = await transferPort(broker, source, destination, carrier.port2);
    const nestedReply = Promise.withResolvers<unknown>();
    const receivedMessage = Promise.withResolvers<MessageEvent>();
    const order: string[] = [];
    nested.port1.once("message", (value: unknown) => nestedReply.resolve(value));

    try {
      carrier.port1.postMessage({ value: "queued", nested: nested.port2 }, [nested.port2]);
      carrier.port1.close();
      await Promise.all([source.ports.drain(), destination.ports.drain()]);
      await broker.drain();

      receivedCarrier.addEventListener("message", (event) => {
        order.push("message");
        receivedMessage.resolve(event as MessageEvent);
      });
      receivedCarrier.on("close", () => order.push("close"));
      const event = await receivedMessage.promise;
      await broker.drain();
      const received = event.data as {
        readonly value: string;
        readonly nested: NodeWorkerMessagePort;
      };
      expect(received.value).toBe("queued");
      expect(received.nested).toBe(event.ports[0]);
      expect(order).toEqual(["message", "close"]);

      received.nested.postMessage("nested still works", []);
      await Promise.all([source.ports.drain(), destination.ports.drain()]);
      await broker.drain();
      await expect(nestedReply.promise).resolves.toBe("nested still works");
    } finally {
      await Promise.all([source.ports.dispose(), destination.ports.dispose()]);
      await broker.drain();
    }

    expect(broker.residentPorts).toBe(0);
  });

  it("releases nested transfers when the unread receiver is explicitly closed", async () => {
    const broker = new NodeWorkerPortBroker();
    const source = publicPortsRuntime("source", broker);
    const destination = publicPortsRuntime("destination", broker);
    const carrier = source.ports.channel();
    const nested = source.ports.channel();
    const _receivedCarrier = await transferPort(broker, source, destination, carrier.port2);
    const nestedPeerEvents: string[] = [];
    nested.port1.on("close", () => nestedPeerEvents.push("close"));

    try {
      carrier.port1.postMessage({ nested: nested.port2 }, [nested.port2]);
      await source.ports.drain();
      await broker.drain();

      await destination.ports.dispose();
      await source.ports.drain();
      await broker.drain();
      expect(nestedPeerEvents).toEqual(["close"]);
    } finally {
      await Promise.all([source.ports.dispose(), destination.ports.dispose()]);
      await broker.drain();
    }

    expect(broker.residentPorts).toBe(0);
  });

  it("discards a disconnected in-flight delivery without poisoning sibling ports", async () => {
    const broker = new NodeWorkerPortBroker();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const source = publicPortsRuntime("source", broker);
    const destination = publicPortsRuntime("destination", broker, async () => {
      entered.resolve();
      await release.promise;
    });
    const sibling = publicPortsRuntime("sibling", broker);
    const disconnected = source.ports.channel();
    const siblingChannel = source.ports.channel();
    const disconnectedPort = await transferPort(broker, source, destination, disconnected.port2);
    const siblingPort = await transferPort(broker, source, sibling, siblingChannel.port2);
    disconnectedPort.on("message", () => undefined);
    const siblingMessages: unknown[] = [];
    siblingPort.on("message", (value: unknown) => siblingMessages.push(value));

    try {
      disconnected.port1.postMessage("discard after disconnect");
      await entered.promise;
      await destination.ports.dispose();
      release.resolve();

      siblingChannel.port1.postMessage("sibling remains usable");
      await Promise.all([source.ports.drain(), sibling.ports.drain()]);
      await broker.drain();
      expect(siblingMessages).toEqual(["sibling remains usable"]);
    } finally {
      release.resolve();
      await Promise.all([
        source.ports.dispose(),
        destination.ports.dispose(),
        sibling.ports.dispose(),
      ]);
      await broker.drain();
    }

    expect(broker.residentPorts).toBe(0);
  });

  it("delivers a pending peer close to the endpoint's current owner", async () => {
    const broker = new NodeWorkerPortBroker();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let holdClose = true;
    const source = publicPortsRuntime("close-source", broker, async (event) => {
      if (holdClose && event.type === "close") {
        holdClose = false;
        entered.resolve();
        await release.promise;
      }
    });
    const destination = publicPortsRuntime("close-destination", broker);
    const carrier = source.ports.channel();
    let closeCount = 0;

    try {
      carrier.port1.close();
      await entered.promise;
      const moved = await transferPort(broker, source, destination, carrier.port2);
      moved.on("close", () => closeCount++);
      await destination.ports.drain();
      release.resolve();
      await broker.drain();

      expect(closeCount).toBe(1);
      expect(moved.hasRef()).toBe(false);
    } finally {
      release.resolve();
      await Promise.allSettled([source.ports.dispose(), destination.ports.dispose()]);
      await broker.drain().catch(() => undefined);
    }
  });

  it("retargets an in-flight message's nested ports before the old owner disconnects", async () => {
    const broker = new NodeWorkerPortBroker();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const source = publicPortsRuntime("move-source", broker, async (event) => {
      if (event.type === "message") {
        entered.resolve();
        await release.promise;
      }
    });
    const destination = publicPortsRuntime("move-destination", broker);
    const carrier = source.ports.channel();
    const nested = source.ports.channel();
    const received: unknown[] = [];
    carrier.port2.on("message", () => {
      throw new Error("stale receiver ran");
    });

    try {
      carrier.port1.postMessage({ nested: nested.port2 }, [nested.port2]);
      await entered.promise;
      const moved = await transferPort(broker, source, destination, carrier.port2);
      moved.on("message", (value: unknown) => received.push(value));
      await destination.ports.drain();
      await source.ports.dispose();
      release.resolve();

      await expect(broker.drain()).resolves.toBeUndefined();
      expect(received).toHaveLength(1);
      expect((received[0] as { readonly nested: unknown }).nested).toBeInstanceOf(
        NodeWorkerMessagePort,
      );
    } finally {
      release.resolve();
      await Promise.allSettled([source.ports.dispose(), destination.ports.dispose()]);
      await broker.drain().catch(() => undefined);
    }

    expect(broker.residentPorts).toBe(0);
  });

  it("keeps an accepted old delivery consumed and disposes its nested transfers", async () => {
    const broker = new NodeWorkerPortBroker();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const source = publicPortsRuntime(
      "accepted-source",
      broker,
      undefined,
      async (event, accepted) => {
        if (event.type === "message") {
          expect(accepted).toBe(true);
          entered.resolve();
          await release.promise;
        }
      },
    );
    const destination = publicPortsRuntime("accepted-destination", broker);
    const carrier = source.ports.channel();
    const nested = source.ports.channel();
    const oldMessages: unknown[] = [];
    const newMessages: unknown[] = [];
    let closeCount = 0;
    carrier.port2.on("message", (value: unknown) => oldMessages.push(value));

    try {
      await source.ports.drain();
      carrier.port1.postMessage({ nested: nested.port2 }, [nested.port2]);
      await entered.promise;
      expect(oldMessages).toHaveLength(1);

      const moved = await transferPort(broker, source, destination, carrier.port2);
      moved.on("message", (value: unknown) => newMessages.push(value));
      moved.on("close", () => closeCount++);
      await destination.ports.drain();
      await source.ports.dispose();
      release.resolve();

      await expect(broker.drain()).resolves.toBeUndefined();
      expect(oldMessages).toHaveLength(1);
      expect(newMessages).toHaveLength(0);
      expect(closeCount).toBe(1);
      expect(moved.hasRef()).toBe(false);
    } finally {
      release.resolve();
      await Promise.allSettled([source.ports.dispose(), destination.ports.dispose()]);
      await broker.drain().catch(() => undefined);
    }

    expect(broker.residentPorts).toBe(0);
  });

  it("does not hold a broker lock while a message handler posts its reply", async () => {
    const broker = new NodeWorkerPortBroker();
    const replied = Promise.withResolvers<void>();
    const first = address("owner/a");
    const second = address("owner/b");
    const connection = broker.connect("owner", {
      async receive(event) {
        if (event.type === "message" && event.port.id === second.id)
          await connection.post(second, message("reply"));
        if (event.type === "message" && event.port.id === first.id) replied.resolve();
        return true;
      },
    });
    await connection.open(first, second);
    await connection.start(first);
    await connection.start(second);
    await connection.post(first, message("request"));
    await replied.promise;
    await connection.close(first);
    await broker.drain();
  });

  it("fences a delayed delivery when its port has moved to another process", async () => {
    const broker = new NodeWorkerPortBroker();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<boolean>();
    const received: NodeWorkerPortEvent[] = [];
    const first = address("parent/a");
    const second = address("parent/b");
    const moved = { ...second, lease: "next" };
    const parent = broker.connect("parent", {
      async receive(event) {
        if (event.type === "message") {
          entered.resolve();
          return release.promise;
        }
        return true;
      },
    });
    const child = broker.connect("child", {
      async receive(event) {
        received.push(event);
        return true;
      },
    });
    await parent.open(first, second);
    await parent.start(second);
    await parent.post(first, message("still queued"));
    await entered.promise;
    await broker.transfer("parent", "child", transfer(moved));
    await child.start(moved);
    release.resolve(false);
    await broker.drain();
    expect(received).toEqual([{ type: "message", port: moved, message: message("still queued") }]);
    await expect(parent.close(second)).rejects.toThrow("lease is stale");
    await child.close(moved);
    await broker.drain();
  });

  it("validates all transferred leases before changing any port owner", async () => {
    const f = fixture();
    const parent = f.connect("parent");
    f.connect("child");
    const first = address("parent/a");
    const second = address("parent/b");
    await parent.open(first, second);
    const one = transfer({ ...first, lease: "fresh" });
    const bad: NodeWorkerMessage = {
      value: one.value,
      ports: [
        ...one.ports,
        { marker: {}, handle: { ...address("missing", "bad"), previousLease: "first" } },
      ],
    };
    await expect(f.broker.transfer("parent", "child", bad)).rejects.toThrow(
      "transfer lease is invalid",
    );
    await parent.close(first);
    await f.broker.drain();
    expect(f.broker.residentPorts).toBe(0);
  });

  it("rejects a delayed transfer after the port returns to the same owner", async () => {
    const f = fixture();
    const parent = f.connect("parent");
    const child = f.connect("child");
    const first = address("parent/a");
    const second = address("parent/b");
    const childLease = { ...second, lease: "child" };
    const returned = { ...second, lease: "returned" };
    await parent.open(first, second);
    await f.broker.transfer("parent", "child", transfer(childLease));
    await f.broker.transfer("child", "parent", transfer(returned, "child"));
    await expect(
      f.broker.transfer("parent", "child", transfer({ ...second, lease: "delayed" })),
    ).rejects.toThrow("transfer lease is invalid");
    await parent.close(returned);
    await f.broker.drain();
    await expect(child.close(childLease)).rejects.toThrow("lease is stale");
    expect(f.broker.residentPorts).toBe(0);
  });

  it("moves transferred ports inside an unread message with its receiving port", async () => {
    const f = fixture();
    const parent = f.connect("parent");
    const child = f.connect("child");
    const sender = address("parent/sender");
    const receiver = address("parent/receiver");
    const nested = address("parent/nested");
    const peer = address("parent/peer");
    const nestedLease = { ...nested, lease: "in-message" };
    const receiverLease = { ...receiver, lease: "child" };
    await parent.open(sender, receiver);
    await parent.open(nested, peer);
    await parent.post(sender, transfer(nestedLease));
    await f.broker.transfer("parent", "child", transfer(receiverLease));
    await child.start(receiverLease);
    await f.broker.drain();
    await child.post(nestedLease, message("nested still works"));
    await parent.start(peer);
    await f.broker.drain();
    expect(
      f.events
        .get("parent")
        ?.some((event) => event.type === "message" && event.message.value === "nested still works"),
    ).toBe(true);
    await child.close(nestedLease);
    await child.close(receiverLease);
    await f.broker.drain();
    expect(f.broker.residentPorts).toBe(0);
  });

  it("retains delivery failures for the supervisor even after the pump has settled", async () => {
    const broker = new NodeWorkerPortBroker();
    const failed = Promise.withResolvers<void>();
    const connection = broker.connect("owner", {
      async receive() {
        failed.resolve();
        throw new Error("receiver gone");
      },
    });
    const first = address("owner/a");
    const second = address("owner/b");
    await connection.open(first, second);
    await connection.start(second);
    await connection.post(first, message("request"));
    await failed.promise;
    await expect(broker.failure).rejects.toThrow("receiver gone");
    await expect(broker.drain()).rejects.toThrow("receiver gone");
  });

  it("fails a live current lease when its receiver rejects a message", async () => {
    const broker = new NodeWorkerPortBroker();
    const rejected = Promise.withResolvers<void>();
    const connection = broker.connect("owner", {
      async receive(event) {
        if (event.type === "message") {
          rejected.resolve();
          return false;
        }
        return true;
      },
    });
    const first = address("owner/a");
    const second = address("owner/b");
    await connection.open(first, second);
    await connection.start(second);
    await connection.post(first, message("reject current lease"));
    await rejected.promise;

    try {
      await expect(broker.failure).rejects.toThrow("current lease");
      await expect(broker.drain()).rejects.toThrow("current lease");
    } finally {
      await broker.disconnect("owner");
      await broker.drain().catch(() => undefined);
    }

    expect(broker.residentPorts).toBe(0);
  });

  it("waits for an accepted callback to settle before reporting another delivery failure", async () => {
    const broker = new NodeWorkerPortBroker();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const failingEntered = Promise.withResolvers<void>();
    const fail = Promise.withResolvers<void>();
    const connection = broker.connect("owner", {
      async receive(event) {
        if (event.type === "message" && event.port.id === "owner/b") {
          entered.resolve();
          await release.promise;
        } else if (event.type === "message") {
          failingEntered.resolve();
          await fail.promise;
        }
        return true;
      },
    });
    const first = address("owner/a");
    const second = address("owner/b");
    const third = address("owner/c");
    const fourth = address("owner/d");
    await connection.open(first, second);
    await connection.open(third, fourth);
    await connection.start(second);
    await connection.start(fourth);
    await connection.post(first, message("held"));
    await entered.promise;
    await connection.post(third, message("failure"));
    await failingEntered.promise;
    let drained = false;
    const draining = broker.drain().finally(() => {
      drained = true;
    });
    void draining.catch(() => undefined);
    fail.reject(new Error("another receiver failed"));
    await expect(broker.failure).rejects.toThrow("another receiver failed");
    expect(drained).toBe(false);
    release.resolve();
    await expect(draining).rejects.toThrow("another receiver failed");
  });
});
