import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  RUNNER_CONNECT_PATH,
  RUNNER_HEARTBEAT_PING,
  RUNNER_HEARTBEAT_PONG,
  runnerFrame,
  type ThreadMessage,
  threadFrame,
} from "@signalbox/runner-protocol/RunnerProtocol";
import type { ThreadId } from "@t3tools/contracts";
import { deriveWsBaseUrl } from "@t3tools/shared/advertisedEndpoint";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Socket from "effect/socket/Socket";

import { RunnerConnectionError, type RunnerTransport } from "./RunnerSession.ts";

/**
 * The Runner's one outbound WebSocket to its thread: `RUNNER_CONNECT_PATH` on
 * the cloud's origin, one JSON frame per message. A dropped network sends no
 * close, so the Runner pings and gives up on a socket that stays silent.
 */

const HEARTBEAT_INTERVAL = "15 seconds";
/** Silence after which the socket counts as dead: three missed heartbeats. */
const SILENCE_LIMIT_MS = 45_000;

export const runnerConnectUrl = (cloudUrl: string, threadId: ThreadId) => {
  const url = new URL(RUNNER_CONNECT_PATH, deriveWsBaseUrl(cloudUrl));
  url.searchParams.set("threadId", threadId);
  return url.toString();
};

const decoder = new TextDecoder();

export const webSocketTransport = (url: string): RunnerTransport => ({
  connect: Effect.gen(function* () {
    const socket = yield* Socket.makeWebSocket(url, { openTimeout: "10 seconds" }).pipe(
      Effect.provide(NodeSocket.layerWebSocketConstructor),
    );
    const failed = (cause: unknown) =>
      new RunnerConnectionError({ message: "The thread connection closed.", cause });
    const reader = yield* Effect.mapError(socket.reader, failed);
    const writer = yield* socket.writer;
    const incoming = yield* Queue.unbounded<ThreadMessage, RunnerConnectionError>();
    const lastHeard = yield* Ref.make(yield* Clock.currentTimeMillis);
    const close = writer.write(new Socket.CloseEvent(1000, "closing")).pipe(Effect.ignore);

    yield* Effect.forever(
      Effect.flatMap(reader.pull, (frames) =>
        Effect.gen(function* () {
          yield* Ref.set(lastHeard, yield* Clock.currentTimeMillis);
          for (const frame of frames) {
            const text = typeof frame === "string" ? frame : decoder.decode(frame);
            if (text !== RUNNER_HEARTBEAT_PONG)
              yield* Queue.offer(incoming, threadFrame.decode(text));
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
      send: (message) => Effect.mapError(writer.write(runnerFrame.encode(message)), failed),
      receive: Queue.take(incoming),
      close,
    };
  }),
});
