import type { AuthEnvironmentScope } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NetAddress from "effect/net/NetAddress";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import * as Socket from "effect/socket/Socket";
import * as SocketServer from "effect/socket/SocketServer";

import type * as Environment from "../environment.ts";
import * as CloudRpc from "./rpc.ts";

/**
 * Serves the environment RPC protocol over one accepted WebSocket, the way
 * `apps/server/src/ws.ts` does per connection: JSON serialization, the
 * connection's own scope authorization, and Effect's socket protocol (which
 * answers the client's keepalive pings). Effect's own upgrade helpers need a
 * Node request, so the object accepts a `WebSocketPair` itself and hands the
 * server end over as the only socket of a one-connection `SocketServer`.
 *
 * Completes when the client goes away.
 */
export const serveConnection = (input: {
  readonly webSocket: WebSocket;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly identity: Environment.CloudEnvironmentIdentity;
  readonly userId: string;
}) =>
  Effect.gen(function* () {
    const socket = yield* Socket.fromWebSocket(Effect.succeed(input.webSocket));
    const closed = yield* Deferred.make<void>();
    const server = SocketServer.SocketServer.of({
      address: NetAddress.unixPathAddress("user-object"),
      run: (handler) =>
        handler(socket).pipe(
          Effect.ignore,
          Effect.andThen(Deferred.succeed(closed, undefined)),
          Effect.andThen(Effect.never),
        ),
    });
    const protocol = yield* RpcServer.makeProtocolSocketServer.pipe(
      Effect.provideService(SocketServer.SocketServer, server),
    );
    yield* RpcServer.make(CloudRpc.CloudRpcGroup, { disableTracing: true }).pipe(
      Effect.provideService(RpcServer.Protocol, protocol),
      Effect.provide(
        Layer.mergeAll(
          CloudRpc.layerHandlers({ identity: input.identity, userId: input.userId }),
          CloudRpc.layerScopeAuthorization(input.scopes),
        ),
      ),
      Effect.raceFirst(Deferred.await(closed)),
    );
  }).pipe(Effect.scoped, Effect.provide(RpcSerialization.layerJson));
