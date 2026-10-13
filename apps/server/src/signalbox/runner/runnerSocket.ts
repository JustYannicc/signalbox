import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  RUNNER_CONNECT_PATH,
  RUNNER_HEARTBEAT_PING,
  RUNNER_HEARTBEAT_PONG,
  runnerFrame,
  threadFrame,
} from "@signalbox/runner-protocol/RunnerProtocol";
import type { ThreadId } from "@t3tools/contracts";
import { deriveWsBaseUrl } from "@t3tools/shared/advertisedEndpoint";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Socket from "effect/socket/Socket";

import { RunnerConnectionError, type RunnerTransport } from "./RunnerSession.ts";

/**
 * The Runner's outbound WebSockets to its thread: the Runner connection at
 * `RUNNER_CONNECT_PATH` and the PreviewGateway's tunnel, both on the cloud's
 * origin. A dropped network sends no close, so the Runner pings and gives up
 * on a socket that stays silent.
 */

const HEARTBEAT_INTERVAL = "15 seconds";
/** Silence after which the socket counts as dead: three missed heartbeats. */
const SILENCE_LIMIT_MS = 45_000;

/** `path` on the cloud's WebSocket origin, for `threadId`. */
export const threadSocketUrl = (cloudUrl: string, path: string, threadId: ThreadId) => {
  const url = new URL(path, deriveWsBaseUrl(cloudUrl));
  url.searchParams.set("threadId", threadId);
  return url.toString();
};

export const runnerConnectUrl = (cloudUrl: string, threadId: ThreadId) =>
  threadSocketUrl(cloudUrl, RUNNER_CONNECT_PATH, threadId);

/** An open socket to the thread. `receive` fails once it closes. */
export interface ThreadSocket<A> {
  readonly send: (frame: string | Uint8Array) => Effect.Effect<void, RunnerConnectionError>;
  readonly receive: Effect.Effect<A, RunnerConnectionError>;
  readonly close: Effect.Effect<void>;
}

/**
 * Opens a WebSocket to `url` that heartbeats and fails `receive` after
 * `SILENCE_LIMIT_MS` without a frame. Every frame but the heartbeat's `pong`
 * goes through `decode`; a frame it throws on closes the socket.
 */
export const openThreadSocket = <A>(
  url: string,
  decode: (frame: string | Uint8Array) => A,
): Effect.Effect<ThreadSocket<A>, RunnerConnectionError, Scope.Scope> =>
  Effect.gen(function* () {
    const socket = yield* Socket.makeWebSocket(url, { openTimeout: "10 seconds" }).pipe(
      Effect.provide(NodeSocket.layerWebSocketConstructor),
    );
    const failed = (cause: unknown) =>
      new RunnerConnectionError({ message: "The thread connection closed.", cause });
    const reader = yield* Effect.mapError(socket.reader, failed);
    const writer = yield* socket.writer;
    const incoming = yield* Queue.unbounded<A, RunnerConnectionError>();
    const lastHeard = yield* Ref.make(yield* Clock.currentTimeMillis);
    const close = writer.write(new Socket.CloseEvent(1000, "closing")).pipe(Effect.ignore);

    yield* Effect.forever(
      Effect.flatMap(reader.pull, (frames) =>
        Effect.gen(function* () {
          yield* Ref.set(lastHeard, yield* Clock.currentTimeMillis);
          for (const frame of frames) {
            if (frame !== RUNNER_HEARTBEAT_PONG) yield* Queue.offer(incoming, decode(frame));
          }
        }),
      ),
    ).pipe(
      Effect.catchCause((cause) => Queue.fail(incoming, failed(cause))),
      Effect.forkScoped,
    );

    yield* Effect.forever(
      Effect.gen(function* () {
        yield* Effect.sleep(HEARTBEAT_INTERVAL);
        const silentFor = (yield* Clock.currentTimeMillis) - (yield* Ref.get(lastHeard));
        if (silentFor < SILENCE_LIMIT_MS) {
          yield* writer.write(RUNNER_HEARTBEAT_PING).pipe(Effect.ignore);
          return;
        }
        yield* Queue.fail(incoming, failed(`No answer for ${silentFor} ms.`));
        yield* close;
      }),
    ).pipe(Effect.forkScoped);

    return {
      send: (frame) => Effect.mapError(writer.write(frame), failed),
      receive: Queue.take(incoming),
      close,
    };
  });

const decoder = new TextDecoder();

export const webSocketTransport = (url: string): RunnerTransport => ({
  connect: Effect.map(
    openThreadSocket(url, (frame) =>
      threadFrame.decode(typeof frame === "string" ? frame : decoder.decode(frame)),
    ),
    (socket) => ({
      send: (message) => socket.send(runnerFrame.encode(message)),
      receive: socket.receive,
      close: socket.close,
    }),
  ),
});
