import { describe, expect, it } from "vite-plus/test";
import * as NodeWorkerThreads from "node:worker_threads";
import {
  NodeWorkerMessagePort,
  NodeWorkerPortBroker,
  NodeWorkerPorts,
} from "../NodeWorkerThreads.ts";
import type {
  NodeWorkerMessage,
  NodeWorkerPortAddress,
  NodeWorkerPortEvent,
} from "../NodeWorkerThreads.ts";

interface Runtime {
  readonly ports: NodeWorkerPorts;
  readonly owner: string;
}

function runtime(
  owner: string,
  broker: NodeWorkerPortBroker,
  options: Readonly<{
    beforeReceive?: (event: NodeWorkerPortEvent) => Promise<void> | void;
    afterReceive?: (event: NodeWorkerPortEvent, result: Promise<boolean>) => void;
    beforeClose?: () => Promise<void> | void;
    beforePost?: (message: NodeWorkerMessage) => Promise<void> | void;
    onOpen?: (addresses: readonly [NodeWorkerPortAddress, NodeWorkerPortAddress]) => void;
    onReferenceChange?: () => void;
  }> = {},
): Runtime {
  const ports = new NodeWorkerPorts({
    owner,
    connect: async (receiver) => {
      const connection = broker.connect(owner, {
        receive: async (event) => {
          await options.beforeReceive?.(event);
          const result = receiver.receive(event);
          options.afterReceive?.(event, result);
          return result;
        },
      });
      return {
        open: async (first, second) => {
          options.onOpen?.([first, second]);
          return connection.open(first, second);
        },
        adopt: connection.adopt,
        post: async (address, message) => {
          await options.beforePost?.(message);
          return connection.post(address, message);
        },
        start: connection.start,
        close: async (address) => {
          await options.beforeClose?.();
          return connection.close(address);
        },
      };
    },
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

  it("exposes transferred ports on MessageEvent in native transfer-list order", async () => {
    const nativeCarrier = new NodeWorkerThreads.MessageChannel();
    const nativeInData = new NodeWorkerThreads.MessageChannel();
    const f = await bridge();
    let nativeEvent: MessageEvent | undefined;

    try {
      const nativeReceived = Promise.withResolvers<MessageEvent>();
      nativeCarrier.port2.addEventListener("message", (event) =>
        nativeReceived.resolve(event as MessageEvent),
      );
      nativeCarrier.port1.postMessage({ endpoint: nativeInData.port2, alias: nativeInData.port2 }, [
        nativeInData.port2,
      ]);
      nativeEvent = await nativeReceived.promise;
      const nativeData = nativeEvent.data as {
        endpoint: NodeWorkerThreads.MessagePort;
        alias: NodeWorkerThreads.MessagePort;
      };
      expect(nativeEvent.ports).toHaveLength(1);
      expect(nativeEvent.ports[0]).toBe(nativeData.endpoint);
      expect(nativeEvent.ports[0]).toBe(nativeData.alias);

      const inData = f.source.ports.channel();
      const onlyInTransfer = f.source.ports.channel();
      const received = Promise.withResolvers<MessageEvent>();
      f.receiverPort.addEventListener("message", (event) =>
        received.resolve(event as MessageEvent),
      );
      f.sourcePort.postMessage({ endpoint: inData.port2, alias: inData.port2 }, [
        inData.port2,
        onlyInTransfer.port2,
      ]);
      const event = await received.promise;
      const data = event.data as {
        endpoint: NodeWorkerMessagePort;
        alias: NodeWorkerMessagePort;
      };
      expect(event.ports).toHaveLength(2);
      expect(event.ports[0]).toBe(data.endpoint);
      expect(event.ports[0]).toBe(data.alias);
      expect(event.ports[1]).not.toBe(data.endpoint);

      const reply = Promise.withResolvers<unknown>();
      onlyInTransfer.port1.once("message", (value: unknown) => reply.resolve(value));
      (event.ports[1] as NodeWorkerMessagePort).postMessage("available from event.ports");
      await Promise.all([f.source.ports.drain(), f.receiver.ports.drain()]);
      await f.broker.drain();
      await expect(reply.promise).resolves.toBe("available from event.ports");
    } finally {
      nativeCarrier.port1.close();
      nativeCarrier.port2.close();
      nativeInData.port1.close();
      for (const port of nativeEvent?.ports ?? []) port.close();
      await dispose(f);
    }
  });

  it("fences a pending message after explicit close and still emits close", async () => {
    const native = new NodeWorkerThreads.MessageChannel();
    const nativeClosed = Promise.withResolvers<void>();
    const nativeMessages: unknown[] = [];
    native.port2.on("message", (value: unknown) => nativeMessages.push(value));
    native.port2.once("close", () => nativeClosed.resolve());
    native.port1.postMessage("pending");
    native.port2.close();
    await nativeClosed.promise;
    native.port1.close();

    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const closeStarted = Promise.withResolvers<void>();
    const releaseClose = Promise.withResolvers<void>();
    const receiveResult = Promise.withResolvers<{ readonly result: Promise<boolean> }>();
    const f = await bridge({
      receiver: {
        beforeReceive: async (event) => {
          if (event.type !== "message") return;
          entered.resolve();
          await release.promise;
        },
        afterReceive: (event, result) => {
          if (event.type === "message") receiveResult.resolve({ result });
        },
        beforeClose: async () => {
          closeStarted.resolve();
          await releaseClose.promise;
        },
      },
    });
    const messages: unknown[] = [];
    let closeCount = 0;
    f.receiverPort.on("message", (value: unknown) => messages.push(value));
    f.receiverPort.on("close", () => closeCount++);

    try {
      await f.receiver.ports.drain();
      f.sourcePort.postMessage("pending");
      await entered.promise;
      f.receiverPort.close();
      await closeStarted.promise;
      release.resolve();
      const { result } = await receiveResult.promise;
      let resultSettled = false;
      void result.then(
        () => {
          resultSettled = true;
        },
        () => {
          resultSettled = true;
        },
      );
      await Promise.resolve();
      expect(resultSettled).toBe(false);
      releaseClose.resolve();
      await f.receiver.ports.drain();
      await f.broker.drain();
      expect(messages).toEqual(nativeMessages);
      expect(closeCount).toBe(1);
    } finally {
      release.resolve();
      releaseClose.resolve();
      native.port1.close();
      native.port2.close();
      await dispose(f);
    }
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
    await receiver.ports.drain();
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

  it("keeps a directly transferred port until its delayed adoption acknowledges the close", async () => {
    const broker = new NodeWorkerPortBroker();
    const source = runtime("delayed-adopt-source", broker);
    const target = runtime("delayed-adopt-target", broker);
    const channel = source.ports.channel();
    await Promise.all([source.ports.drain(), target.ports.drain()]);
    const packet = source.ports.encode({ port: channel.port2 }, [channel.port2]);
    await source.ports.drain();
    await broker.transfer(source.owner, target.owner, packet);
    channel.port1.close();
    await source.ports.drain();
    await broker.drain();

    const moved = target.ports.decode(packet) as { port: NodeWorkerMessagePort };
    let closeCount = 0;
    moved.port.on("close", () => closeCount++);
    await target.ports.drain();
    await broker.drain();

    expect(closeCount).toBe(1);
    expect(moved.port.hasRef()).toBe(false);
    expect(broker.residentPorts).toBe(0);
    await Promise.all([source.ports.dispose(), target.ports.dispose()]);
    await broker.drain();
  });

  it("retains a detached source lease when peer close arrives before its move", async () => {
    const broker = new NodeWorkerPortBroker();
    const source = runtime("detached-source", broker);
    const target = runtime("detached-target", broker);
    const channel = source.ports.channel();
    await Promise.all([source.ports.drain(), target.ports.drain()]);
    const packet = source.ports.encode({ port: channel.port2 }, [channel.port2]);
    channel.port1.close();
    await source.ports.drain();
    await broker.drain();

    await broker.transfer(source.owner, target.owner, packet);
    const moved = target.ports.decode(packet) as { port: NodeWorkerMessagePort };
    let closeCount = 0;
    moved.port.on("close", () => closeCount++);
    await target.ports.drain();
    await broker.drain();

    expect(closeCount).toBe(1);
    expect(moved.port.hasRef()).toBe(false);
    expect(broker.residentPorts).toBe(0);
    await Promise.all([source.ports.dispose(), target.ports.dispose()]);
    await broker.drain();
  });

  it("joins a queued post before close ACK and closes its unadopted transfer", async () => {
    const broker = new NodeWorkerPortBroker();
    const deliveryEntered = Promise.withResolvers<void>();
    const releaseDelivery = Promise.withResolvers<void>();
    const postEntered = Promise.withResolvers<void>();
    const releasePost = Promise.withResolvers<void>();
    const closeEntered = Promise.withResolvers<void>();
    const releaseClose = Promise.withResolvers<void>();
    const opened: Array<readonly [NodeWorkerPortAddress, NodeWorkerPortAddress]> = [];
    const source = runtime("pending-adopt-source", broker, {
      onOpen: (addresses) => opened.push(addresses),
      beforeReceive: async (event) => {
        if (event.type === "message") {
          deliveryEntered.resolve();
          await releaseDelivery.promise;
        }
        if (event.type === "close" && event.port.id === opened[1]?.[0]?.id) {
          closeEntered.resolve();
          await releaseClose.promise;
        }
      },
      beforePost: async (message) => {
        if ((message.value as { kind?: unknown }).kind === "late") {
          postEntered.resolve();
          await releasePost.promise;
        }
      },
    });
    const target = runtime("pending-adopt-target", broker);
    const outer = source.ports.channel();
    const nested = source.ports.channel();
    const deep = source.ports.channel();
    let deepCloses = 0;
    deep.port1.on("message", () => undefined);
    deep.port1.on("close", () => deepCloses++);
    outer.port2.on("message", () => {
      throw new Error("Retired outer receiver ran");
    });

    try {
      outer.port1.postMessage({ nested: nested.port2 }, [nested.port2]);
      await deliveryEntered.promise;
      const packet = source.ports.encode({ port: outer.port2 }, [outer.port2]);
      await Promise.all([source.ports.drain(), target.ports.drain()]);
      await broker.transfer(source.owner, target.owner, packet);
      const moved = target.ports.decode(packet) as { port: NodeWorkerMessagePort };
      nested.port1.postMessage({ kind: "late", deep: deep.port2 }, [deep.port2]);
      await postEntered.promise;
      moved.port.close();
      await target.ports.drain();
      releaseDelivery.resolve();
      await closeEntered.promise;

      const sourceDrain = source.ports.drain();
      void sourceDrain.catch(() => undefined);
      releasePost.resolve();
      await sourceDrain;
      releaseClose.resolve();
      await broker.drain();

      expect(deepCloses).toBe(1);
      expect(deep.port1.hasRef()).toBe(false);
      expect(broker.residentPorts).toBe(0);
    } finally {
      releaseDelivery.resolve();
      releasePost.resolve();
      releaseClose.resolve();
      await Promise.allSettled([source.ports.dispose(), target.ports.dispose()]);
      await broker.drain().catch(() => undefined);
    }
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
