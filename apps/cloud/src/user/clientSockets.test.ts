import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthProvidersManageScope,
  EnvironmentId,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Stream from "effect/Stream";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";

import { makeMemoryCloud } from "../testing.ts";
import { ClientSockets, type ClientSocketHost, type ClientSocketState } from "./clientSockets.ts";

type Listener = (event: { readonly data?: unknown; readonly code?: number }) => void;

/**
 * A Durable Object's hibernatable sockets and storage, which outlive the
 * object's memory. Each `wake` is the object coming back: new socket handles
 * over the same sockets, and the handles of earlier lifetimes go dead, the
 * way a hibernated object's memory does.
 */
const makeObject = () => {
  const kv = new Map<string, unknown>();
  const sockets: Array<{
    tags: Array<string>;
    attachment: unknown;
    readonly client: ReturnType<typeof clientEnd>;
    closed: boolean;
  }> = [];
  let lifetime = 0;
  let current: ClientSockets | undefined;

  /** Hands a client's frame to the live object. One cut off by `stop` fails with the runtime, harmlessly. */
  const deliver = (handler: (object: ClientSockets) => Promise<void>) => {
    if (current === undefined) return;
    handler(current).catch((cause: unknown) => {
      if (current !== undefined) throw cause;
    });
  };

  /** The client's side: an Effect `WebSocketLike` whose frames go to the live object. */
  const clientEnd = (index: () => number) => {
    const listeners = new Map<string, Set<Listener>>();
    return {
      readyState: 1,
      emit: (type: string, event: object) => {
        for (const listener of Array.from(listeners.get(type) ?? [])) listener(event);
      },
      addEventListener: (type: string, listener: Listener) => {
        const set = listeners.get(type) ?? new Set();
        set.add(listener);
        listeners.set(type, set);
      },
      removeEventListener: (type: string, listener: Listener) => {
        listeners.get(type)?.delete(listener);
      },
      send: (data: string) => {
        queueMicrotask(() => deliver((object) => object.message(handle(index(), lifetime), data)));
      },
      close: () => {
        queueMicrotask(() =>
          deliver((object) => object.closed(handle(index(), lifetime), 1000, "")),
        );
      },
    };
  };

  const handles = new Map<string, WebSocket>();
  /** The object's handle on socket `index` in `born`'s lifetime. */
  const handle = (index: number, born: number) => {
    const key = `${born}:${index}`;
    const existing = handles.get(key);
    if (existing) return existing;
    const socket = sockets[index]!;
    const made = {
      serializeAttachment: (value: unknown) => {
        socket.attachment = structuredClone(value);
      },
      deserializeAttachment: () => structuredClone(socket.attachment),
      send: (data: string) => {
        if (born !== lifetime || socket.closed) return;
        queueMicrotask(() => socket.client.emit("message", { data }));
      },
      close: (code: number) => {
        if (socket.closed) return;
        socket.closed = true;
        socket.client.readyState = 3;
        queueMicrotask(() => socket.client.emit("close", { code }));
      },
    } as unknown as WebSocket;
    handles.set(key, made);
    return made;
  };

  const state: ClientSocketState = {
    acceptWebSocket: (socket, tags) => {
      sockets.find((_, index) => handles.get(`${lifetime}:${index}`) === socket)!.tags = tags;
    },
    getWebSockets: (tag) =>
      sockets.flatMap((socket, index) =>
        !socket.closed && (tag === undefined || socket.tags.includes(tag))
          ? [handle(index, lifetime)]
          : [],
      ),
    storage: {
      kv: {
        get: <T>(key: string) => kv.get(key) as T | undefined,
        put: (key, value) => void kv.set(key, structuredClone(value)),
        delete: (key) => kv.delete(key),
        list: <T>(options?: { readonly prefix?: string }) =>
          [...kv.entries()]
            .filter(([key]) => key.startsWith(options?.prefix ?? ""))
            .toSorted(([a], [b]) => a.localeCompare(b)) as Array<[string, T]>,
      },
    },
  };

  return {
    kv,
    sockets,
    /** The object goes away for good: frames still in flight reach nothing. */
    stop: () => {
      current = undefined;
    },
    /** Starts a lifetime of the object, restoring what its sockets had open. */
    wake: async (host: Omit<ClientSocketHost, "ctx">, now = 0) => {
      lifetime += 1;
      current = new ClientSockets({ ...host, ctx: state });
      await current.restore(now, "u");
      return current;
    },
    /** Accepts a new socket the way the object's `fetch` does, returning the client's end. */
    connect: async (expiresAt = Number.MAX_SAFE_INTEGER) => {
      const index = sockets.length;
      sockets.push({ tags: [], attachment: null, client: clientEnd(() => index), closed: false });
      await current!.accept(
        handle(index, lifetime),
        { sid: `s${index}`, scopes, expiresAt },
        "u",
        "mobile",
      );
      return sockets[index]!.client;
    },
  };
};

const identity = { environmentId: EnvironmentId.make("cloud-test"), label: "Cloud" };
const scopes = [
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  AuthProvidersManageScope,
];

/** An RPC client on `end`, built into the test's scope the way the client session builds it. */
const clientOn = (end: Socket.WebSocketLike) =>
  Effect.gen(function* () {
    const protocol = yield* Layer.build(
      Layer.effect(RpcClient.Protocol, RpcClient.makeProtocolSocket()).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.effect(Socket.Socket, Socket.fromWebSocket(Effect.succeed(end))),
            RpcSerialization.layerJson,
          ),
        ),
      ),
    );
    return yield* RpcClient.make(WsRpcGroup).pipe(Effect.provide(protocol));
  });

/** A subscription's pool names until it sees two pools, once it has seen the first list. */
const follow = <E>(stream: Stream.Stream<ReadonlyArray<{ readonly name: string }>, E>) =>
  Effect.gen(function* () {
    const listed = yield* Deferred.make<void>();
    const fiber = yield* stream.pipe(
      Stream.map((pools) => pools.map((pool) => pool.name)),
      Stream.tap(() => Deferred.succeed(listed, undefined)),
      Stream.takeUntil((names) => names.length === 2),
      Stream.runCollect,
      Effect.forkScoped,
    );
    yield* Deferred.await(listed);
    return fiber;
  });

const setup = Effect.gen(function* () {
  const logs: Array<string> = [];
  const logging = Logger.layer([Logger.map(Logger.formatJson, (line) => void logs.push(line))]);
  const cloud = makeMemoryCloud();
  yield* cloud.userDirectory.forUser("u").recordSignIn({ id: "u", email: "u@example.com" });
  const context = yield* Layer.build(cloud.layerFor("u"));
  // The object's runtime: everything it runs lives until the test ends.
  const run = yield* FiberSet.makeRuntimePromise();
  const host: Omit<ClientSocketHost, "ctx"> = {
    identity,
    run: (effect) => run(Effect.provideContext(effect, context).pipe(Effect.provide(logging))),
  };
  const object = makeObject();
  // Runs before the runtime closes, so frames a closing client sends find no object.
  yield* Effect.addFinalizer(() => Effect.sync(object.stop));
  return { host, object, logs };
});

describe("ClientSockets", () => {
  it.live("records legacy sockets and expiry without inventing connection metadata", () =>
    Effect.gen(function* () {
      const { host, object, logs } = yield* setup;
      yield* Effect.promise(() => object.wake(host));
      yield* Effect.promise(() => object.connect(100));
      const legacy = object.sockets[0]!;
      const {
        clientKind: _kind,
        openedAt: _opened,
        ...attachment
      } = legacy.attachment as Record<string, unknown>;
      legacy.attachment = attachment;
      logs.length = 0;

      const sockets = yield* Effect.promise(() => object.wake(host, 50));
      yield* Effect.promise(() => sockets.expire(100));
      yield* Effect.promise(() => sockets.expire(100));
      const recorded = logs.join("\n");
      expect(recorded).toContain('"kind":"unknown"');
      expect(recorded).toContain('"openedAt":null');
      expect(recorded).toContain('"cause":"expired"');
      expect(logs.filter((line) => line.includes('"action":"closed"'))).toHaveLength(1);
      expect(logs.filter((line) => line.includes('"action":"opened"'))).toHaveLength(0);
    }).pipe(Effect.scoped),
  );

  it.live(
    "records connections and actual client RPCs across hibernation without their content",
    () =>
      Effect.gen(function* () {
        const { host, object, logs } = yield* setup;
        yield* Effect.promise(() => object.wake(host));
        const end = yield* Effect.promise(() => object.connect());
        const client = yield* clientOn(end as unknown as Socket.WebSocketLike);
        const pools = yield* follow(client[WS_METHODS.accountPoolSubscribe]({}));
        const beforeWake = logs.filter((line) => line.includes('"action":"rpc"')).length;
        const sockets = yield* Effect.promise(() => object.wake(host));
        expect(logs.filter((line) => line.includes('"action":"rpc"'))).toHaveLength(beforeWake);

        const canary = "PRIVATE_POOL_NAME_5";
        yield* client[WS_METHODS.accountPoolCreate]({ name: canary });
        yield* Fiber.join(pools);
        yield* Effect.promise(() => sockets.revoke("s0"));
        yield* Effect.promise(() => sockets.revoke("s0"));

        const recorded = logs.join("\n");
        expect(logs.filter((line) => line.includes('"action":"opened"'))).toHaveLength(1);
        expect(logs.filter((line) => line.includes('"action":"restored"'))).toHaveLength(1);
        expect(logs.filter((line) => line.includes('"action":"closed"'))).toHaveLength(1);
        expect(logs.filter((line) => line.includes('"action":"rpc"'))).toHaveLength(2);
        expect(recorded).toContain('"method":"accountPool.create"');
        expect(recorded).toContain('"kind":"mobile"');
        expect(recorded).toContain('"cause":"revoked"');
        expect(recorded).toContain('"connections":0');
        expect(recorded).toContain('"connections":1');
        expect(recorded).not.toContain(canary);
        expect(recorded).not.toContain('"sid"');
        expect(recorded).not.toContain('"scopes"');
      }).pipe(Effect.scoped),
  );

  it.live("a subscription keeps getting changes after the object hibernates", () =>
    Effect.gen(function* () {
      const { host, object } = yield* setup;
      yield* Effect.promise(() => object.wake(host));
      const watcher = yield* clientOn(
        (yield* Effect.promise(() => object.connect())) as unknown as Socket.WebSocketLike,
      );
      const editor = yield* clientOn(
        (yield* Effect.promise(() => object.connect())) as unknown as Socket.WebSocketLike,
      );
      const pools = yield* follow(watcher[WS_METHODS.accountPoolSubscribe]({}));

      // Everything in memory is gone; the sockets and storage are not.
      yield* Effect.promise(() => object.wake(host));
      yield* editor[WS_METHODS.accountPoolCreate]({ name: "Work" });

      expect(yield* Fiber.join(pools)).toContainEqual(["Personal", "Work"]);
    }).pipe(Effect.scoped),
  );

  it.live("keeps only subscriptions that are still open", () =>
    Effect.gen(function* () {
      const { host, object } = yield* setup;
      yield* Effect.promise(() => object.wake(host));
      const client = yield* clientOn(
        (yield* Effect.promise(() => object.connect())) as unknown as Socket.WebSocketLike,
      );
      const stored = () =>
        [...object.kv.values()].map((message) => (message as { tag: string }).tag);

      const pools = yield* follow(client[WS_METHODS.accountPoolSubscribe]({}));
      yield* client[WS_METHODS.accountPoolCreate]({ name: "Work" });
      expect(stored()).toEqual([WS_METHODS.accountPoolSubscribe]);

      // Seeing two pools ends the client's stream, which interrupts the request.
      yield* Fiber.join(pools);
      yield* Effect.promise(() => object.wake(host));
      expect(stored()).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.live("disconnects sockets once their session expires", () =>
    Effect.gen(function* () {
      const { host, object } = yield* setup;
      const sockets = yield* Effect.promise(() => object.wake(host));
      yield* Effect.promise(() => object.connect(1_000));
      yield* Effect.promise(() => object.connect(5_000));

      expect(yield* Effect.promise(() => sockets.expire(2_000))).toBe(5_000);
      expect(object.sockets.map((socket) => socket.closed)).toEqual([true, false]);
    }).pipe(Effect.scoped),
  );
});
