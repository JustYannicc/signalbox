import { describe, expect, it } from "vite-plus/test";
import {
  NodeWorkerPortBroker,
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
