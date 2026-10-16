import {
  type DataFrame,
  PREVIEW_TUNNEL_VERSION,
  type PreviewPort,
  readDataFrame,
  tunnelRunnerFrame,
  type TunnelThreadMessage,
  tunnelThreadFrame,
} from "@signalbox/runner-protocol/PreviewTunnel";
import type { ThreadId } from "@t3tools/contracts";
import type { AgentBrowserStep } from "@t3tools/contracts/signalboxPreviews";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";

import { makeTrailSender, serveMirror } from "./previewMirror.ts";
import { proxyHttp, type ProxyStream, proxyWebSocket, type TunnelFrame } from "./previewProxy.ts";
import type { BrowserMirror, MirrorViewer } from "./RunnerBrowserMirror.ts";
import { RunnerConnectionError, reconnectDelay } from "./RunnerSession.ts";
import { openThreadSocket } from "./runnerSocket.ts";

/**
 * The machine end of the PreviewGateway's tunnel (`PreviewTunnel.ts` in the
 * runner protocol): a second outbound socket to the thread, next to the
 * Runner's own, that reports the machine's web servers and proxies the
 * thread's HTTP requests and WebSockets to them (`previewProxy.ts`). It
 * reconnects after every drop, aborting the streams the drop broke, until
 * the thread refuses it or its scope closes with the Runner's generation.
 *
 * With the agent's browser (`mirror`), it also serves viewers' mirrors and
 * uploads every finished trail step (`previewMirror.ts`). Steps that finish
 * while the tunnel is down wait for the next connection, the newest kept.
 */

/** Bytes of trail steps kept while the tunnel is down. */
const TRAIL_BACKLOG_BYTES = 32 * 1024 * 1024;

/** One open tunnel socket. `receive` fails once it closes. */
export interface PreviewTunnelConnection {
  readonly send: (frame: TunnelFrame) => Effect.Effect<void, RunnerConnectionError>;
  readonly receive: Effect.Effect<TunnelThreadMessage | DataFrame, RunnerConnectionError>;
  readonly close: Effect.Effect<void>;
}

/** Opens tunnel sockets; each lives as long as the scope it was opened in. */
export interface PreviewTunnelTransport {
  readonly connect: Effect.Effect<PreviewTunnelConnection, RunnerConnectionError, Scope.Scope>;
}

/** The web servers listening on the machine. */
export interface PreviewPortSource {
  /** Reports the ports now and whenever they change, while the scope lasts. */
  readonly watch: (
    report: (ports: ReadonlyArray<PreviewPort>) => Effect.Effect<void>,
  ) => Effect.Effect<void, never, Scope.Scope>;
}

export interface PreviewTunnelInput {
  readonly threadId: ThreadId;
  /** The Runner session's generation and token: the thread serves only its lease holder. */
  readonly generation: number;
  readonly token: string;
  readonly transport: PreviewTunnelTransport;
  readonly ports: PreviewPortSource;
  /** The agent's browser, which viewers watch through the thread. */
  readonly mirror?: BrowserMirror;
}

export interface PreviewTunnel {
  /** Why the tunnel stopped: the thread refused it, or its scope closed. */
  readonly ended: Effect.Effect<string>;
}

const encoder = new TextEncoder();

const decodeFrame = (frame: string | Uint8Array): TunnelThreadMessage | DataFrame => {
  if (typeof frame === "string") return tunnelThreadFrame.decode(frame);
  const data = readDataFrame(frame);
  if (data === null) throw new Error("The thread sent a data frame of an unknown kind.");
  return data;
};

export const previewTunnelTransport = (url: string): PreviewTunnelTransport => ({
  connect: Effect.map(openThreadSocket(url, decodeFrame), (socket) => ({
    send: (frame) =>
      socket.send(frame instanceof Uint8Array ? frame : tunnelRunnerFrame.encode(frame)),
    receive: socket.receive,
    close: socket.close,
  })),
});

export const runPreviewTunnel = Effect.fn("runPreviewTunnel")(function* (
  input: PreviewTunnelInput,
): Effect.fn.Return<PreviewTunnel, never, Scope.Scope> {
  const ended = yield* Deferred.make<string>();
  yield* Effect.addFinalizer(() => Deferred.succeed(ended, "stopped"));
  const log = { threadId: input.threadId, generation: input.generation };

  // Plain variables: every read and write below happens in one synchronous step.
  let ports: ReadonlyArray<PreviewPort> = [];
  /** Sends the ports on the welcomed connection, if there is one. */
  let reportPorts: ((ports: ReadonlyArray<PreviewPort>) => void) | null = null;
  let welcomed = false;
  /** Steps waiting for a welcomed connection; `uploadStep` sends on the current one. */
  const backlog: Array<{ readonly step: AgentBrowserStep; readonly events: Uint8Array }> = [];
  let uploadStep: ((step: AgentBrowserStep, events: Uint8Array) => void) | null = null;
  const sendTrailStep = makeTrailSender();
  const mirror = input.mirror;
  if (mirror !== undefined) {
    const unsubscribe = mirror.onStep((step, events) => {
      const bytes = encoder.encode(events);
      if (uploadStep !== null) return uploadStep(step, bytes);
      backlog.push({ step, events: bytes });
      let kept = backlog.reduce((sum, entry) => sum + entry.events.byteLength, 0);
      while (kept > TRAIL_BACKLOG_BYTES && backlog.length > 1)
        kept -= backlog.shift()!.events.byteLength;
    });
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
  }

  yield* input.ports
    .watch((next) =>
      Effect.sync(() => {
        ports = next;
        reportPorts?.(next);
      }),
    )
    .pipe(Effect.forkScoped);

  /** One connection, from `hello` until it closes. */
  const connectOnce = Effect.scoped(
    Effect.gen(function* () {
      const connection = yield* input.transport.connect;
      yield* connection.send({
        type: "hello",
        version: PREVIEW_TUNNEL_VERSION,
        threadId: input.threadId,
        generation: input.generation,
        token: input.token,
        ...(mirror === undefined ? {} : { mirror: true }),
      });
      const answer = yield* connection.receive;
      if ("type" in answer && answer.type === "refused") {
        yield* Deferred.succeed(ended, `refused: ${answer.message}`);
        return;
      }
      if (!("type" in answer) || answer.type !== "welcome") {
        return yield* new RunnerConnectionError({ message: "Expected the thread's welcome." });
      }
      welcomed = true;
      yield* Effect.logInfo("preview tunnel connected", log);

      // Streams answer from Node callbacks; one writer keeps their frames in order.
      const outbox = yield* Queue.unbounded<TunnelFrame>();
      const streams = new Map<number, ProxyStream>();
      const mirrors = new Map<number, MirrorViewer>();
      const emit = (frame: TunnelFrame) => void Queue.offerUnsafe(outbox, frame);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          reportPorts = null;
          uploadStep = null;
          // The thread fails its side of every stream when the socket goes.
          for (const stream of streams.values()) stream.abort();
          streams.clear();
          for (const viewer of mirrors.values()) viewer.close();
          mirrors.clear();
        }),
      );
      yield* Effect.sync(() => {
        reportPorts = (next) => emit({ type: "ports", ports: next });
        reportPorts(ports);
        uploadStep = (step, events) => sendTrailStep(emit, step, events);
        for (const entry of backlog.splice(0)) uploadStep(entry.step, entry.events);
      });

      const open = (message: Extract<TunnelThreadMessage, { type: "request" | "ws.open" }>) => {
        const { stream, port } = message;
        streams.get(stream)?.abort();
        if (!ports.some((reported) => reported.port === port)) {
          return emit({ type: "fail", stream, message: `Nothing serves port ${port} here.` });
        }
        const proxyInput = { emit, done: () => void streams.delete(stream) };
        try {
          streams.set(
            stream,
            message.type === "request"
              ? proxyHttp(message, proxyInput)
              : proxyWebSocket(message, proxyInput),
          );
        } catch (error) {
          emit({ type: "fail", stream, message: String(error) });
        }
      };

      const watch = (message: Extract<TunnelThreadMessage, { type: "mirror.open" }>) => {
        const { stream } = message;
        mirrors.get(stream)?.close();
        if (mirror === undefined)
          return emit({ type: "fail", stream, message: "This machine has no browser to mirror." });
        mirrors.set(
          stream,
          serveMirror(mirror, message, emit, () => void mirrors.delete(stream)),
        );
      };

      const dispatch = (message: TunnelThreadMessage | DataFrame) => {
        if (!("type" in message)) {
          return streams.get(message.stream)?.data(message.kind, message.payload);
        }
        switch (message.type) {
          case "request":
          case "ws.open":
            return open(message);
          case "mirror.open":
            return watch(message);
          case "mirror.input":
            return mirrors.get(message.stream)?.input(message.input);
          case "end":
            return streams.get(message.stream)?.end();
          case "cancel":
            mirrors.get(message.stream)?.close();
            mirrors.delete(message.stream);
            return streams.get(message.stream)?.abort();
          case "ws.close":
            return streams.get(message.stream)?.close(message.code, message.reason);
          default:
            return;
        }
      };

      const writeLoop = Effect.forever(
        Effect.flatMap(Queue.takeAll(outbox), (frames) =>
          Effect.forEach(frames, connection.send, { discard: true }),
        ),
      );
      const readLoop = Effect.forever(
        Effect.flatMap(connection.receive, (message) => Effect.sync(() => dispatch(message))),
      );
      return yield* Effect.raceFirst(readLoop, writeLoop);
    }),
  );

  // Connects, and reconnects after every drop until the thread refuses the tunnel.
  yield* Effect.gen(function* () {
    let failures = 0;
    while (!(yield* Deferred.isDone(ended))) {
      welcomed = false;
      const exit = yield* Effect.exit(connectOnce);
      if (yield* Deferred.isDone(ended)) return;
      yield* Effect.logInfo("preview tunnel closed", {
        ...log,
        ...(exit._tag === "Failure" ? { cause: Cause.pretty(exit.cause).split("\n")[0] } : {}),
      });
      failures = welcomed ? 0 : failures + 1;
      yield* Effect.sleep(reconnectDelay(failures));
    }
  }).pipe(Effect.forkScoped);

  return { ended: Deferred.await(ended) };
});
