import { describe, expect, it } from "vite-plus/test";
import {
  NodeWorkerMessagePort,
  NodeWorkerPortBroker,
  NodeWorkerPorts,
} from "../NodeWorkerThreads.ts";
import type { NodeWorkerPortEvent } from "../NodeWorkerThreads.ts";

interface Runtime {
  readonly ports: NodeWorkerPorts;
  readonly owner: string;
}

function runtime(
  owner: string,
  broker: NodeWorkerPortBroker,
  options: Readonly<{
    beforeReceive?: (event: NodeWorkerPortEvent) => Promise<void> | void;
    onReferenceChange?: () => void;
  }> = {},
): Runtime {
  const ports = new NodeWorkerPorts({
    owner,
    connect: (receiver) =>
      Promise.resolve(
        broker.connect(owner, {
          receive: async (event) => {
            await options.beforeReceive?.(event);
            return receiver.receive(event);
          },
        }),
      ),
    disconnect: () => broker.disconnect(owner),
    ...(options.onReferenceChange === undefined
      ? {}
      : { onReferenceChange: options.onReferenceChange }),
  });
  return { owner, ports };
}

async function bridge(options: Readonly<{ receiver?: Parameters<typeof runtime>[2] }> = {}) {
  const broker = new NodeWorkerPortBroker();
  const source = runtime("source", broker);
  const receiver = runtime("receiver", broker, options.receiver);
  const channel = source.ports.channel();
  const packet = source.ports.encode({ port: channel.port2 }, [channel.port2]);
  await Promise.all([source.ports.drain(), receiver.ports.drain()]);
  await broker.transfer(source.owner, receiver.owner, packet);
  const { port } = receiver.ports.decode(packet) as { port: NodeWorkerMessagePort };
  return { broker, source, receiver, sourcePort: channel.port1, receiverPort: port };
}

async function dispose(f: Awaited<ReturnType<typeof bridge>>): Promise<void> {
  await Promise.all([f.source.ports.dispose(), f.receiver.ports.dispose()]);
  await f.broker.drain();
}

describe("worker message port facade", () => {
  it("emits close exactly once on both ends when a local port closes", async () => {
    const f = await bridge();
    const closed: string[] = [];
    f.sourcePort.on("close", () => closed.push("source"));
    f.receiverPort.on("close", () => closed.push("receiver"));
    f.sourcePort.close();
    f.sourcePort.close();
    await f.source.ports.drain();
    await f.broker.drain();
    expect(closed.sort()).toEqual(["receiver", "source"]);
    expect(f.broker.residentPorts).toBe(0);
    await dispose(f);
  });

  it("buffers until start and delivers queued messages before close", async () => {
    const f = await bridge();
    const messages: unknown[] = [];
    const events: string[] = [];
    f.receiverPort.on("close", () => events.push("close"));
    f.sourcePort.postMessage("one");
    f.sourcePort.postMessage("two");
    await f.source.ports.drain();
    await f.broker.drain();
    expect(messages).toEqual([]);

    f.receiverPort.on("message", (value: unknown) => {
      messages.push(value);
      events.push(String(value));
    });
    await f.receiver.ports.drain();
    await f.broker.drain();
    expect(messages).toEqual(["one", "two"]);

    f.sourcePort.postMessage("three");
    f.sourcePort.postMessage("four");
    f.sourcePort.close();
    await Promise.all([f.source.ports.drain(), f.receiver.ports.drain()]);
    await f.broker.drain();
    expect(messages).toEqual(["one", "two", "three", "four"]);
    expect(events).toEqual(["one", "two", "three", "four", "close"]);
    expect(f.receiverPort.hasRef()).toBe(false);
    expect(f.receiver.ports.referenced).toBe(false);
    await dispose(f);
  });

  it("clones and detaches synchronously, while a bad clone leaves transfers usable", async () => {
    const f = await bridge();
    const events: MessageEvent[] = [];
    f.receiverPort.addEventListener("message", (event) => events.push(event as MessageEvent));
    const buffer = new ArrayBuffer(3);
    new Uint8Array(buffer).set([8, 16, 32]);
    f.sourcePort.postMessage({ buffer }, { transfer: [buffer] });
    expect(buffer.byteLength).toBe(0);
    await f.source.ports.drain();
    await f.broker.drain();
    const firstEvent = events[0];
    if (firstEvent === undefined) throw new Error("Transferred buffer message was not received");
    expect(firstEvent.target).toBe(f.receiverPort);
    expect([...new Uint8Array((firstEvent.data as { buffer: ArrayBuffer }).buffer)]).toEqual([
      8, 16, 32,
    ]);

    const stillUsable = f.source.ports.channel();
    await f.source.ports.drain();
    const received = Promise.withResolvers<unknown>();
    stillUsable.port2.once("message", (value: unknown) => received.resolve(value));
    const failedBuffer = new ArrayBuffer(2);
    expect(() =>
      f.sourcePort.postMessage({ invalid: () => undefined, port: stillUsable.port1 }, [
        failedBuffer,
        stillUsable.port1,
      ]),
    ).toThrow(expect.objectContaining({ name: "DataCloneError" }));
    expect(failedBuffer.byteLength).toBe(2);
    stillUsable.port1.postMessage("still attached");
    await f.source.ports.drain();
    await f.broker.drain();
    await expect(received.promise).resolves.toBe("still attached");
    await dispose(f);
  });

  it("keeps transferred ports working after their creator exits", async () => {
    const f = await bridge();
    const moved = Promise.withResolvers<{ ports: NodeWorkerMessagePort[] }>();
    f.receiverPort.on("message", (value: unknown) => {
      moved.resolve(value as { ports: NodeWorkerMessagePort[] });
    });
    const pair = f.source.ports.channel();
    await f.source.ports.drain();
    f.sourcePort.postMessage({ ports: [pair.port1, pair.port2] }, [pair.port1, pair.port2]);
    const transferred = await moved.promise;
    expect(transferred.ports).toHaveLength(2);
    await f.source.ports.drain();
    await f.broker.drain();
    await f.source.ports.dispose();

    const reply = Promise.withResolvers<unknown>();
    transferred.ports[0]!.once("message", (value: unknown) => reply.resolve(value));
    transferred.ports[1]!.postMessage("after creator exit");
    await f.receiver.ports.drain();
    await f.broker.drain();
    await expect(reply.promise).resolves.toBe("after creator exit");
    expect(f.broker.residentPorts).toBe(2);
    await f.receiver.ports.dispose();
    await f.broker.drain();
    expect(f.broker.residentPorts).toBe(0);
  });

  it("validates adoption shape, duplicate IDs, and locally stale leases before installing ports", async () => {
    const broker = new NodeWorkerPortBroker();
    const source = runtime("source", broker);
    const receiver = runtime("receiver", broker);
    const channel = source.ports.channel();
    const second = source.ports.channel();
    const packet = source.ports.encode({ ports: [channel.port2, second.port2] }, [
      channel.port2,
      second.port2,
    ]);
    await Promise.all([source.ports.drain(), receiver.ports.drain()]);
    await broker.transfer(source.owner, receiver.owner, packet);
    const firstEntry = packet.ports[0]!;
    const handle = firstEntry.handle;
    expect(() => receiver.ports.adopt({ id: "", lease: "empty-id" })).toThrow(
      expect.objectContaining({ name: "DataCloneError" }),
    );
    expect(() => receiver.ports.adopt({ id: "valid-id", lease: "" })).toThrow(
      expect.objectContaining({ name: "DataCloneError" }),
    );

    const invalidPacket = {
      ...packet,
      ports: [
        firstEntry,
        {
          ...packet.ports[1]!,
          handle: { ...packet.ports[1]!.handle, id: "" },
        },
      ],
    };
    expect(() => receiver.ports.decode(invalidPacket)).toThrow(
      expect.objectContaining({ name: "DataCloneError" }),
    );
    const adopted = receiver.ports.adopt(handle);
    expect(() => receiver.ports.adopt(handle)).toThrow(
      expect.objectContaining({ name: "DataCloneError" }),
    );
    const returned = receiver.ports.encode({ port: adopted }, [adopted]);
    expect(() => receiver.ports.adopt({ id: handle.id, lease: handle.lease })).toThrow(
      expect.objectContaining({ name: "DataCloneError" }),
    );
    await broker.transfer(receiver.owner, source.owner, returned);
    const returnedPort = source.ports.decode(returned) as { port: NodeWorkerMessagePort };
    expect(returnedPort.port).toBeInstanceOf(NodeWorkerMessagePort);
    await Promise.all([source.ports.dispose(), receiver.ports.dispose()]);
    await broker.drain();
  });

  it("rejects a late delivery after lease transfer and delivers it to the new owner", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const f = await bridge({
      receiver: {
        beforeReceive: async (event) => {
          if (event.type === "message") {
            entered.resolve();
            await release.promise;
          }
        },
      },
    });
    const delivered = Promise.withResolvers<unknown>();
    f.receiverPort.on("message", () => undefined);
    await f.receiver.ports.drain();
    f.sourcePort.postMessage("late message");
    await f.source.ports.drain();
    await entered.promise;

    const transfer = f.receiver.ports.encode({ port: f.receiverPort }, [f.receiverPort]);
    await brokerTransfer(f, transfer);
    const moved = f.source.ports.decode(transfer) as { port: NodeWorkerMessagePort };
    moved.port.on("message", (value: unknown) => delivered.resolve(value));
    await f.source.ports.drain();
    release.resolve();
    await f.broker.drain();
    await expect(delivered.promise).resolves.toBe("late message");
    await dispose(f);
  });

  it("tracks ref and unref and lets a receiving callback reply and dispose", async () => {
    const f = await bridge();
    expect(f.source.ports.referenced).toBe(false);
    expect(f.sourcePort.hasRef()).toBe(true);
    f.sourcePort.on("message", () => undefined);
    expect(f.source.ports.referenced).toBe(true);
    f.sourcePort.unref();
    expect(f.sourcePort.hasRef()).toBe(false);
    expect(f.source.ports.referenced).toBe(false);
    f.sourcePort.ref();
    expect(f.sourcePort.hasRef()).toBe(true);
    expect(f.source.ports.referenced).toBe(true);

    const reply = Promise.withResolvers<unknown>();
    const disposed = Promise.withResolvers<void>();
    f.sourcePort.once("message", (value: unknown) => reply.resolve(value));
    f.receiverPort.on("message", async (value: unknown) => {
      if (value !== "request") return;
      f.receiverPort.postMessage("reply");
      await f.receiver.ports.drain();
      await f.receiver.ports.dispose();
      disposed.resolve();
    });
    f.sourcePort.postMessage("request");
    await Promise.all([f.source.ports.drain(), f.receiver.ports.drain()]);
    await expect(reply.promise).resolves.toBe("reply");
    await disposed.promise;
    await f.broker.drain();
    expect(f.receiver.ports.referenced).toBe(false);
    await f.source.ports.dispose();
    await f.broker.drain();
  });

  it("reports listener and reference-hook failures without throwing from transfer commit", async () => {
    const f = await bridge();
    f.receiverPort.on("message", () => {
      throw new Error("message listener failed");
    });
    f.sourcePort.postMessage("fail");
    await f.source.ports.drain();
    await expect(f.broker.drain()).rejects.toThrow("message listener failed");
    await expect(f.receiver.ports.failure).rejects.toThrow("message listener failed");
    await Promise.allSettled([f.source.ports.dispose(), f.receiver.ports.dispose()]);

    const broker = new NodeWorkerPortBroker();
    const owner = runtime("hook", broker, {
      onReferenceChange: () => {
        throw new Error("reference hook failed");
      },
    });
    const channel = owner.ports.channel();
    await owner.ports.drain();
    expect(() => owner.ports.encode({ port: channel.port2 }, [channel.port2])).not.toThrow();
    await expect(owner.ports.failure).rejects.toThrow("reference hook failed");
    await expect(owner.ports.dispose()).rejects.toThrow("reference hook failed");
    await broker.drain();
  });
});

async function brokerTransfer(
  f: Awaited<ReturnType<typeof bridge>>,
  message: ReturnType<NodeWorkerPorts["encode"]>,
): Promise<void> {
  await f.receiver.ports.drain();
  await f.broker.transfer(f.receiver.owner, f.source.owner, message);
}
