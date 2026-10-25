import { describe, expect, it } from "@effect/vitest";
import {
  decodeWorkerMessage,
  encodeWorkerMessage,
  type WorkerMessagePortHandle,
  type WorkerMessagePortHooks,
} from "../NodeWorkerThreads.ts";

type TestPort = { readonly id: string; readonly lease: string };

function makePortRegistry(rejectPrepare = false) {
  const registered = new WeakSet<object>();
  const attached = new WeakSet<object>();
  const handles = new Map<string, WorkerMessagePortHandle>();
  let nextId = 0;
  let prepares = 0;
  let commits = 0;
  let adoptions = 0;

  const makePort = (id: string, lease: string): TestPort => {
    const port = { id, lease };
    registered.add(port);
    attached.add(port);
    return port;
  };

  const hooks: WorkerMessagePortHooks<TestPort> = {
    isPort(value): value is TestPort {
      return value !== null && typeof value === "object" && registered.has(value);
    },
    prepareTransfer(port) {
      prepares++;
      if (rejectPrepare || !attached.has(port)) {
        throw new DOMException("The port cannot be transferred", "DataCloneError");
      }
      const handle = { id: port.id, lease: `lease-${++nextId}`, previousLease: port.lease };
      handles.set(handle.lease, handle);
      return {
        handle,
        commit() {
          attached.delete(port);
          commits++;
        },
      };
    },
    adoptTransfers(transfers) {
      adoptions++;
      return transfers.map((handle) => {
        expect(handles.get(handle.lease)).toEqual(handle);
        return makePort(handle.id, handle.lease);
      });
    },
  };

  return {
    hooks,
    createPort: (id: string) => makePort(id, `origin-${id}`),
    isAttached: (port: TestPort) => attached.has(port),
    get prepares() {
      return prepares;
    },
    get commits() {
      return commits;
    },
    get adoptions() {
      return adoptions;
    },
  };
}

const dataCloneError = expect.objectContaining({ name: "DataCloneError" });

describe("worker message codec", () => {
  it("preserves cycles, aliases, sparse arrays, getters, and an own __proto__ key", () => {
    const shared = { count: 3 };
    const array: unknown[] = [];
    array.length = 5;
    array[2] = shared;
    const source: Record<string, unknown> = { array, first: shared, second: shared };
    source.self = source;
    Object.defineProperty(source, "__proto__", {
      value: { safe: true },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    let reads = 0;
    Object.defineProperty(source, "readOnce", {
      enumerable: true,
      get() {
        reads++;
        return this === source ? "source receiver" : "wrong receiver";
      },
    });

    const packet = encodeWorkerMessage(source, { ports: makePortRegistry().hooks });
    const clone = packet.value as typeof source;

    expect(reads).toBe(1);
    expect(clone).not.toBe(source);
    expect(clone.self).toBe(clone);
    expect(clone.first).toBe(clone.second);
    expect(clone.array).not.toBe(array);
    expect((clone.array as unknown[]).length).toBe(5);
    expect(0 in (clone.array as unknown[])).toBe(false);
    expect(2 in (clone.array as unknown[])).toBe(true);
    expect((clone.array as unknown[])[2]).toBe(clone.first);
    expect(Object.getPrototypeOf(clone)).toBe(Object.prototype);
    expect(Object.hasOwn(clone, "__proto__")).toBe(true);
    expect((clone as Record<string, { safe: boolean }>)["__proto__"]).toEqual({ safe: true });
    expect(clone.readOnce).toBe("source receiver");
  });

  it("keeps native byte, view, Map, Set, Date, RegExp, and Error cause behavior", () => {
    const buffer = new ArrayBuffer(12);
    new Uint8Array(buffer).set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    const bytes = new Uint8Array(buffer, 3, 5);
    const view = new DataView(buffer, 2, 7);
    const shared = { value: 17 };
    const map = new Map<unknown, unknown>();
    const set = new Set<unknown>();
    map.set(shared, set);
    set.add(shared);
    set.add(map);
    const error = new TypeError("bad input", { cause: shared });
    const regexp = /signalbox/gi;
    regexp.lastIndex = 4;
    const source = { buffer, bytes, view, map, set, date: new Date(1234), regexp, error, shared };

    const clone = encodeWorkerMessage(source, { ports: makePortRegistry().hooks })
      .value as typeof source;

    expect(clone.buffer).not.toBe(buffer);
    expect(clone.bytes.buffer).toBe(clone.buffer);
    expect(clone.view.buffer).toBe(clone.buffer);
    expect(clone.bytes.byteOffset).toBe(3);
    expect(clone.bytes.byteLength).toBe(5);
    expect([...clone.bytes]).toEqual([3, 4, 5, 6, 7]);
    expect(clone.view.byteOffset).toBe(2);
    expect(clone.view.byteLength).toBe(7);
    expect(clone.map.get(clone.shared)).toBe(clone.set);
    expect(clone.set.has(clone.shared)).toBe(true);
    expect(clone.set.has(clone.map)).toBe(true);
    expect(clone.date).toEqual(new Date(1234));
    expect(clone.regexp.source).toBe("signalbox");
    expect(clone.regexp.flags).toBe("gi");
    expect(clone.regexp.lastIndex).toBe(0);
    expect(clone.error).toBeInstanceOf(TypeError);
    expect(clone.error.message).toBe("bad input");
    expect(clone.error.cause).toBe(clone.shared);
  });

  it("snapshots a binary backing store before later getters and preserves its aliases", () => {
    const makeMessage = () => {
      const buffer = new ArrayBuffer(8);
      new Uint8Array(buffer).set([0, 1, 2, 3, 4, 5, 6, 7]);
      const message: {
        bytes: Uint8Array;
        view: DataView;
        words: Uint16Array;
        buffer: ArrayBuffer;
        date: Date;
        mutate?: boolean;
        self?: unknown;
      } = {
        bytes: new Uint8Array(buffer, 2, 3),
        view: new DataView(buffer, 1, 6),
        words: new Uint16Array(buffer, 0, 4),
        buffer,
        date: new Date(1234),
      };
      Object.defineProperty(message, "mutate", {
        enumerable: true,
        get() {
          new Uint8Array(buffer)[2] = 7;
          message.date.setTime(7000);
          return true;
        },
      });
      message.self = message;
      return message;
    };

    const native = structuredClone(makeMessage());
    const encoded = encodeWorkerMessage(makeMessage(), { ports: makePortRegistry().hooks });
    const clone = encoded.value as ReturnType<typeof makeMessage>;

    expect(clone.bytes[0]).toBe(native.bytes[0]);
    expect(clone.bytes[0]).toBe(2);
    expect(clone.bytes.buffer).toBe(clone.buffer);
    expect(clone.view.buffer).toBe(clone.buffer);
    expect(clone.words.buffer).toBe(clone.buffer);
    expect(clone.bytes.byteOffset).toBe(2);
    expect(clone.view.byteOffset).toBe(1);
    expect(clone.words.byteOffset).toBe(0);
    expect(clone.date).toEqual(native.date);
    expect(clone.date).toEqual(new Date(1234));
    expect(clone.self).toBe(clone);
  });

  it("keeps same-isolate SharedArrayBuffer views attached to the real shared backing", () => {
    const shared = new SharedArrayBuffer(4);
    const bytes = new Uint8Array(shared);
    const clone = encodeWorkerMessage(
      { shared, bytes },
      { ports: makePortRegistry().hooks, sharedMemory: "same-isolate" },
    ).value as { shared: SharedArrayBuffer; bytes: Uint8Array };

    bytes[0] = 9;

    expect(clone.shared).not.toBe(shared);
    expect(clone.bytes.buffer).toBe(clone.shared);
    expect(clone.bytes[0]).toBe(9);
    clone.bytes[1] = 7;
    expect(bytes[1]).toBe(7);
  });

  it("preserves length-tracking views that share a resizable backing store", () => {
    const makeMessage = () => {
      const buffer = new ArrayBuffer(8, { maxByteLength: 16 });
      return { bytes: new Uint8Array(buffer, 2), words: new Uint16Array(buffer) };
    };
    const native = structuredClone(makeMessage());
    const clone = encodeWorkerMessage(makeMessage(), { ports: makePortRegistry().hooks }).value as {
      bytes: Uint8Array;
      words: Uint16Array;
    };

    (native.bytes.buffer as ArrayBuffer).resize(10);
    (clone.bytes.buffer as ArrayBuffer).resize(10);

    expect(clone.bytes.length).toBe(native.bytes.length);
    expect(clone.words.length).toBe(native.words.length);
  });

  it("keeps transferred backing stores on native clone and detachment semantics", () => {
    const makeMessage = () => {
      const buffer = new ArrayBuffer(1);
      const bytes = new Uint8Array(buffer);
      bytes[0] = 1;
      return {
        buffer,
        value: {
          bytes,
          get mutate() {
            bytes[0] = 7;
            return true;
          },
        },
      };
    };
    const nativeInput = makeMessage();
    const native = structuredClone(nativeInput.value, { transfer: [nativeInput.buffer] });
    const input = makeMessage();
    const encoded = encodeWorkerMessage(input.value, {
      transfer: [input.buffer],
      ports: makePortRegistry().hooks,
    });
    const clone = encoded.value as { bytes: Uint8Array };

    expect(clone.bytes[0]).toBe(native.bytes[0]);
    expect(input.buffer.byteLength).toBe(0);
  });

  it("omits an own property deleted by an earlier getter", () => {
    const makeMessage = () => {
      const message: { first?: number; later?: number } = {
        get first() {
          delete message.later;
          return 1;
        },
        later: 2,
      };
      return message;
    };
    const native = structuredClone(makeMessage());
    const encoded = encodeWorkerMessage(makeMessage(), { ports: makePortRegistry().hooks });
    const clone = encoded.value as object;

    expect(Object.keys(clone)).toEqual(Object.keys(native));
    expect(clone).toEqual(native);
  });

  it("clones a later own property made non-enumerable by an earlier getter", () => {
    const makeMessage = () => {
      const message: { first?: number; later?: number } = {
        get first() {
          Object.defineProperty(message, "later", { enumerable: false });
          return 1;
        },
        later: 2,
      };
      return message;
    };
    const native = structuredClone(makeMessage());
    const encoded = encodeWorkerMessage(makeMessage(), { ports: makePortRegistry().hooks });
    const clone = encoded.value as object;

    expect(Object.keys(clone)).toEqual(Object.keys(native));
    expect(clone).toEqual(native);
    expect(clone).toHaveProperty("later", 2);
  });

  it("reads a later Map value after an earlier entry getter mutates it", () => {
    const makeMessage = () => {
      const later: Record<string, number> = { removed: 1 };
      const first = {
        get mutate() {
          delete later.removed;
          later.added = 2;
          return true;
        },
      };
      return new Map<string, object>([
        ["first", first],
        ["later", later],
      ]);
    };
    const native = structuredClone(makeMessage());
    const encoded = encodeWorkerMessage(makeMessage(), { ports: makePortRegistry().hooks });
    const clone = encoded.value as Map<string, Record<string, number>>;

    expect(Object.keys(clone.get("later")!)).toEqual(Object.keys(native.get("later")!));
    expect(clone.get("later")).toEqual(native.get("later"));
    expect(clone.get("later")).toEqual({ added: 2 });
  });

  it("keeps Map membership in native traversal order when a getter changes the source Map", () => {
    const makeMessage = () => {
      let message: Map<string, object>;
      const first = {
        get mutate() {
          message.delete("later");
          message.set("added", { value: 2 });
          return true;
        },
      };
      message = new Map<string, object>([
        ["first", first],
        ["later", { value: 1 }],
      ]);
      return message;
    };
    const native = structuredClone(makeMessage());
    const encoded = encodeWorkerMessage(makeMessage(), { ports: makePortRegistry().hooks });
    const clone = encoded.value as Map<string, object>;

    expect(Array.from(clone)).toEqual(Array.from(native));
    expect(Array.from(clone.keys())).toEqual(["first", "later"]);
  });

  it("transfers a logical port once and replaces every alias by its adopted port", () => {
    const registry = makePortRegistry();
    const port = registry.createPort("peer-1");
    const shape = { id: "peer-1", lease: "looks-like-a-handle" };
    const source: Record<string, unknown> = {
      first: port,
      second: port,
      shape,
      map: new Map([[port, { peer: port }]]),
      set: new Set([port]),
    };
    source.self = source;

    const packet = encodeWorkerMessage(source, { transfer: [port], ports: registry.hooks });
    const marker = packet.ports[0]!.marker;
    const encoded = packet.value as typeof source;

    expect(encoded.first).toBe(marker);
    expect(encoded.second).toBe(marker);
    expect((encoded.map as Map<object, { peer: object }>).get(marker)?.peer).toBe(marker);
    expect(registry.isAttached(port)).toBe(false);
    expect(registry.commits).toBe(1);

    const received = decodeWorkerMessage<TestPort, typeof source>(packet, registry.hooks);
    const receivedPort = received.first as TestPort;
    expect(received.first).toBe(received.second);
    expect((received.map as Map<TestPort, { peer: TestPort }>).get(receivedPort)?.peer).toBe(
      receivedPort,
    );
    expect((received.set as Set<TestPort>).has(receivedPort)).toBe(true);
    expect(received.self).toBe(received);
    expect(received.shape).toEqual(shape);
    expect(registry.hooks.isPort(received.shape)).toBe(false);
    expect(registry.adoptions).toBe(1);
  });

  it("does not interpret a user object shaped like a handle as a port marker", () => {
    const registry = makePortRegistry();
    const shape = { id: "user-data", lease: "ordinary-value" };
    const encoded = encodeWorkerMessage({ shape }, { ports: registry.hooks });
    const decoded = decodeWorkerMessage<TestPort, { shape: object }>(encoded, registry.hooks);

    expect(decoded.shape).toEqual(shape);
    expect(registry.hooks.isPort(decoded.shape)).toBe(false);
    expect(registry.adoptions).toBe(0);
  });

  it("detaches transferred ArrayBuffers only after native validation succeeds", () => {
    const registry = makePortRegistry();
    const port = registry.createPort("peer-2");
    const buffer = new ArrayBuffer(4);
    new Uint8Array(buffer).set([8, 9, 10, 11]);

    expect(() =>
      encodeWorkerMessage(
        { buffer, invalid: () => 1 },
        { transfer: [buffer, port], ports: registry.hooks },
      ),
    ).toThrow(dataCloneError);

    expect(buffer.byteLength).toBe(4);
    expect(registry.isAttached(port)).toBe(true);
    expect(registry.commits).toBe(0);
  });

  it("moves the port and detaches the buffer after a valid clone", () => {
    const registry = makePortRegistry();
    const port = registry.createPort("peer-5");
    const buffer = new ArrayBuffer(4);
    new Uint8Array(buffer).set([1, 3, 5, 7]);

    const packet = encodeWorkerMessage(
      { port, buffer },
      { transfer: [buffer, port], ports: registry.hooks },
    );

    expect(buffer.byteLength).toBe(0);
    expect([...new Uint8Array((packet.value as { buffer: ArrayBuffer }).buffer)]).toEqual([
      1, 3, 5, 7,
    ]);
    expect(registry.isAttached(port)).toBe(false);
    expect(registry.commits).toBe(1);
  });

  it("rejects SharedArrayBuffer and its views before detaching any ArrayBuffer", () => {
    const registry = makePortRegistry();
    const buffer = new ArrayBuffer(4);
    const shared = new SharedArrayBuffer(4);

    for (const value of [
      { buffer, shared },
      { buffer, view: new Uint8Array(shared) },
    ]) {
      expect(() =>
        encodeWorkerMessage(value, { transfer: [buffer], ports: registry.hooks }),
      ).toThrow(dataCloneError);
      expect(buffer.byteLength).toBe(4);
    }

    expect(() =>
      encodeWorkerMessage({ ok: true }, { transfer: [buffer, shared], ports: registry.hooks }),
    ).toThrow(dataCloneError);
    expect(buffer.byteLength).toBe(4);
  });

  it("rejects missing, duplicate, and ineligible port transfers without changing ownership", () => {
    const registry = makePortRegistry();
    const port = registry.createPort("peer-3");
    const buffer = new ArrayBuffer(3);

    expect(() => encodeWorkerMessage({ port }, { ports: registry.hooks })).toThrow(dataCloneError);
    expect(registry.isAttached(port)).toBe(true);

    expect(() =>
      encodeWorkerMessage({ port }, { transfer: [buffer, port, port], ports: registry.hooks }),
    ).toThrow(dataCloneError);
    expect(registry.prepares).toBe(0);
    expect(buffer.byteLength).toBe(3);

    const rejectingRegistry = makePortRegistry(true);
    const ineligible = rejectingRegistry.createPort("peer-4");
    expect(() =>
      encodeWorkerMessage(
        { ineligible },
        {
          transfer: [buffer, ineligible],
          ports: rejectingRegistry.hooks,
        },
      ),
    ).toThrow(dataCloneError);
    expect(buffer.byteLength).toBe(3);
    expect(rejectingRegistry.isAttached(ineligible)).toBe(true);
    expect(rejectingRegistry.commits).toBe(0);
  });

  it("rejects native uncloneables as DataCloneError", () => {
    const hooks = makePortRegistry().hooks;
    for (const value of [() => 1, Symbol("no"), new WeakMap()]) {
      expect(() => encodeWorkerMessage({ value }, { ports: hooks })).toThrow(dataCloneError);
    }
  });

  it("rejects proxies without running their traps", () => {
    let traps = 0;
    const proxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          traps++;
          return Object.prototype;
        },
        ownKeys() {
          traps++;
          return [];
        },
      },
    );
    const hooks = makePortRegistry().hooks;

    expect(() => structuredClone(proxy)).toThrow(dataCloneError);
    expect(() => encodeWorkerMessage(proxy, { ports: hooks })).toThrow(dataCloneError);
    expect(traps).toBe(0);
  });
});
