import type { AuthEnvironmentScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Tracer from "effect/Tracer";
import {
  type FromClientEncoded,
  type FromServerEncoded,
  ResponseDefectEncoded,
} from "effect/rpc/RpcMessage";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";

import type * as Environment from "../environment.ts";
import * as ClientRpcTracing from "../observability/clientRpcTracing.ts";
import * as CloudRpc from "./rpc.ts";

/**
 * Serves the environment RPC protocol to one client socket, the way
 * `apps/server/src/ws.ts` does per connection: JSON serialization, the
 * connection's own scope authorization, and Effect's RPC server. The socket
 * itself stays with the caller (see `clientSockets.ts`), which hands every
 * frame the client sends to `receive` and gets every frame for the client in
 * `send`, so the object can leave memory between messages.
 *
 * Lives until its scope closes. `replay` are requests the client sent to an
 * earlier connection on the same socket that are still open; the new server
 * runs them again under the client's request ids.
 */
export interface Connection {
  /** Hands the server one frame the client sent. */
  readonly receive: (frame: string | ArrayBuffer) => Effect.Effect<void>;
}

/** The one client of a connection's server. */
const CLIENT_ID = 0;

const decoder = new TextDecoder();

export const openConnection = (input: {
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly identity: Environment.CloudEnvironmentIdentity;
  readonly userId: string;
  readonly sid: string;
  /** Sends one encoded frame, along with the message it encodes. */
  readonly send: (frame: string, message: FromServerEncoded) => void;
  /** Sees every message the client sends, just before the server gets it. */
  readonly receiving?: (message: FromClientEncoded) => void;
  readonly replay?: ReadonlyArray<FromClientEncoded>;
}) =>
  Effect.gen(function* () {
    const serialization = yield* RpcSerialization.RpcSerialization;
    const traceSink = yield* ClientRpcTracing.ClientRpcTraceSink;
    const tracer = ClientRpcTracing.makeClientRpcTracer(input.userId, traceSink.submit);
    const parser = serialization.makeUnsafe();
    const send = (message: FromServerEncoded) =>
      Effect.sync(() => {
        let frame: string | Uint8Array | undefined;
        try {
          frame = parser.encode(message);
        } catch (cause) {
          frame = parser.encode(ResponseDefectEncoded(String(cause)));
        }
        if (frame === undefined) return;
        input.send(typeof frame === "string" ? frame : decoder.decode(frame), message);
      });
    let write!: (clientId: number, message: FromClientEncoded) => Effect.Effect<void>;
    const protocol = yield* RpcServer.Protocol.make((writeRequest) => {
      write = writeRequest;
      return Effect.gen(function* () {
        return {
          // The connection ends with its scope, never through the protocol.
          disconnects: yield* Queue.make<number>(),
          send: (_clientId: number, message: FromServerEncoded) => send(message),
          end: () => Effect.void,
          clientIds: Effect.succeed(new Set([CLIENT_ID])),
          initialMessage: Effect.succeedNone,
          supportsAck: true,
          supportsTransferables: false,
          supportsSpanPropagation: true,
          supportsNotifications: true,
          codecFor: serialization.codecFor,
        };
      });
    });
    yield* RpcServer.make(CloudRpc.CloudRpcGroup, { spanPrefix: "RpcServer" }).pipe(
      Effect.provideService(RpcServer.Protocol, protocol),
      Effect.provide(
        Layer.mergeAll(
          CloudRpc.layerHandlers({
            identity: input.identity,
            userId: input.userId,
            sid: input.sid,
            scopes: input.scopes,
            via: "client",
          }),
          CloudRpc.layerScopeAuthorization(input.scopes),
        ),
      ),
      Effect.provideService(Tracer.Tracer, tracer),
      Effect.forkScoped,
    );
    for (const message of input.replay ?? []) {
      yield* Effect.provideService(write(CLIENT_ID, message), Tracer.Tracer, tracer);
    }

    const receive = (frame: string | ArrayBuffer) =>
      Effect.suspend(() => {
        let messages: ReadonlyArray<FromClientEncoded>;
        try {
          messages = parser.decode(
            typeof frame === "string" ? frame : new Uint8Array(frame),
          ) as ReadonlyArray<FromClientEncoded>;
        } catch (cause) {
          return send(ResponseDefectEncoded(String(cause)));
        }
        return Effect.forEach(
          messages,
          (message) =>
            Effect.andThen(
              Effect.sync(() => input.receiving?.(message)),
              Effect.provideService(write(CLIENT_ID, message), Tracer.Tracer, tracer),
            ),
          { discard: true },
        );
      });
    return { receive } satisfies Connection;
  }).pipe(Effect.provide(RpcSerialization.layerJson));
