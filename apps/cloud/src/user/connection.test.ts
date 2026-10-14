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
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";

import { makeMemoryCloud } from "../testing.ts";
import { serveConnection } from "./connection.ts";

type Listener = (event: { readonly data?: unknown; readonly code?: number }) => void;

/** Two connected in-memory WebSocket ends, open from the start, delivering asynchronously like a real socket. */
const webSocketPair = () => {
  const make = () => {
    const listeners = new Map<string, Set<Listener>>();
    const end = {
      readyState: 1,
      peer: undefined as unknown as { emit: (type: string, event: object) => void },
      // Messages wait for a listener, like an accepted socket's do before its reader starts.
      pending: [] as Array<object>,
      emit: (type: string, event: object) => {
        const current = [...(listeners.get(type) ?? [])];
        if (type === "message" && current.length === 0) end.pending.push(event);
        for (const listener of current) listener(event);
      },
      addEventListener: (type: string, listener: Listener) => {
        const set = listeners.get(type) ?? new Set();
        set.add(listener);
        listeners.set(type, set);
        if (type === "message") {
          const pending = end.pending.splice(0);
          queueMicrotask(() => pending.forEach((event) => listener(event)));
        }
      },
      removeEventListener: (type: string, listener: Listener) => {
        listeners.get(type)?.delete(listener);
      },
      send: (data: string | Uint8Array) => {
        queueMicrotask(() => end.peer.emit("message", { data }));
      },
      close: (code = 1000) => {
        end.readyState = 3;
        queueMicrotask(() => end.peer.emit("close", { code }));
      },
      accept: () => {},
    };
    return end;
  };
  const a = make();
  const b = make();
  a.peer = b;
  b.peer = a;
  return [a, b] as const;
};

const identity = { environmentId: EnvironmentId.make("cloud-test"), label: "Cloud" };
const scopes = [
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  AuthProvidersManageScope,
];

describe("serveConnection", () => {
  it.live("a created pool reaches pool subscriptions over the socket", () =>
    Effect.gen(function* () {
      const cloud = makeMemoryCloud();
      yield* cloud.userDirectory.forUser("u").recordSignIn({ id: "u", email: "u@example.com" });
      const [clientEnd, serverEnd] = webSocketPair();

      yield* serveConnection({
        webSocket: serverEnd as unknown as WebSocket,
        scopes,
        identity,
        userId: "u",
      }).pipe(Effect.provide(cloud.layerFor("u")), Effect.forkScoped);

      // Built into the test's scope, the way the client session builds it.
      const protocol = yield* Layer.build(
        Layer.effect(RpcClient.Protocol, RpcClient.makeProtocolSocket()).pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.effect(
                Socket.Socket,
                Socket.fromWebSocket(Effect.succeed(clientEnd as unknown as Socket.WebSocketLike)),
              ),
              RpcSerialization.layerJson,
            ),
          ),
        ),
      );
      const client = yield* RpcClient.make(WsRpcGroup).pipe(Effect.provide(protocol));

      // Each subscription's names until it sees two pools, once it has seen the first list.
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
      const views = yield* follow(client[WS_METHODS.accountPoolSubscribeViews]({}));
      const list = yield* follow(client[WS_METHODS.accountPoolSubscribe]({}));

      yield* client[WS_METHODS.accountPoolCreate]({ name: "Work" });

      expect(yield* Fiber.join(list)).toContainEqual(["Personal", "Work"]);
      expect(yield* Fiber.join(views)).toContainEqual(["Personal", "Work"]);
    }).pipe(Effect.scoped),
  );
});
