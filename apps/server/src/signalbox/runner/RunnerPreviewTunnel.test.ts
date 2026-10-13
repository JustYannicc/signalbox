// @effect-diagnostics nodeBuiltinImport:off - real dev servers on ephemeral ports.
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import { NodeWS } from "@effect/platform-node-shared/NodeSocket";
import { describe, expect, it } from "@effect/vitest";
import {
  DATA_KIND,
  type DataFrame,
  type DataKind,
  dataFrame,
  MAX_DATA_BYTES,
  MAX_WS_MESSAGE_BYTES,
  PREVIEW_TUNNEL_PATH,
  type PreviewPort,
  readDataFrame,
  type TunnelRunnerMessage,
  tunnelRunnerFrame,
  type TunnelThreadMessage,
  tunnelThreadFrame,
} from "@signalbox/runner-protocol/PreviewTunnel";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";

import type { TunnelFrame } from "./previewProxy.ts";
import {
  type PreviewPortSource,
  previewTunnelTransport,
  type PreviewTunnelTransport,
  runPreviewTunnel,
} from "./RunnerPreviewTunnel.ts";
import { RunnerConnectionError } from "./RunnerSession.ts";
import { threadSocketUrl } from "./runnerSocket.ts";

const threadId = ThreadId.make("thread-1");
const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface FakeSocket {
  /** What the Runner sent, in order. */
  readonly fromRunner: Queue.Queue<TunnelFrame>;
  readonly toRunner: (message: TunnelThreadMessage | DataFrame) => Effect.Effect<void>;
  /** Drops the socket, as a network failure would. */
  readonly drop: Effect.Effect<void>;
}

/** The thread's side: every socket the Runner opens arrives on `sockets` for the test to drive. */
const makeFakeThread = Effect.gen(function* () {
  const sockets = yield* Queue.unbounded<FakeSocket>();
  const transport: PreviewTunnelTransport = {
    connect: Effect.gen(function* () {
      const fromRunner = yield* Queue.unbounded<TunnelFrame>();
      const inbox = yield* Queue.unbounded<
        TunnelThreadMessage | DataFrame,
        RunnerConnectionError
      >();
      const drop = Effect.asVoid(
        Queue.fail(inbox, new RunnerConnectionError({ message: "dropped" })),
      );
      yield* Queue.offer(sockets, {
        fromRunner,
        toRunner: (message) => Effect.asVoid(Queue.offer(inbox, message)),
        drop,
      });
      return {
        send: (frame) => Effect.asVoid(Queue.offer(fromRunner, frame)),
        receive: Queue.take(inbox),
        close: drop,
      };
    }),
  };
  return { sockets, transport };
});

/** A port source the test sets by hand. */
const makePorts = (initial: ReadonlyArray<PreviewPort>) => {
  let current = initial;
  let report: ((ports: ReadonlyArray<PreviewPort>) => Effect.Effect<void>) | null = null;
  const source: PreviewPortSource = {
    watch: (next) =>
      Effect.suspend(() => {
        report = next;
        return next(current);
      }),
  };
  const set = (ports: ReadonlyArray<PreviewPort>) =>
    Effect.suspend(() => {
      current = ports;
      return report === null ? Effect.void : report(ports);
    });
  return { source, set };
};

const startTunnel = (ports: ReadonlyArray<number>) =>
  Effect.gen(function* () {
    const thread = yield* makeFakeThread;
    const portSource = makePorts(ports.map((port) => ({ port, processName: "node" })));
    const tunnel = yield* runPreviewTunnel({
      threadId,
      generation: 3,
      token: "lease-token",
      transport: thread.transport,
      ports: portSource.source,
    });
    return { thread, tunnel, setPorts: portSource.set };
  });

const next = (socket: FakeSocket) => Queue.take(socket.fromRunner);

const nextControl = (socket: FakeSocket) =>
  Effect.map(next(socket), (frame): TunnelRunnerMessage => {
    if (frame instanceof Uint8Array) throw new Error("Expected a control frame, got data.");
    return frame;
  });

const nextData = (socket: FakeSocket) =>
  Effect.map(next(socket), (frame): DataFrame => {
    const data = frame instanceof Uint8Array ? readDataFrame(frame) : null;
    if (data === null) throw new Error(`Expected data, got ${JSON.stringify(frame)}.`);
    return data;
  });

/** Takes the next socket, checks its hello, and welcomes it. */
const welcome = (thread: { readonly sockets: Queue.Queue<FakeSocket> }) =>
  Effect.gen(function* () {
    const socket = yield* Queue.take(thread.sockets);
    expect(yield* nextControl(socket)).toEqual({
      type: "hello",
      version: 1,
      threadId,
      generation: 3,
      token: "lease-token",
    });
    yield* socket.toRunner({ type: "welcome" });
    return socket;
  });

const data = (stream: number, kind: DataKind, payload: Uint8Array) =>
  readDataFrame(dataFrame(stream, kind, payload))!;

const request = (
  stream: number,
  port: number,
  path: string,
  extra: Partial<Extract<TunnelThreadMessage, { type: "request" }>> = {},
): TunnelThreadMessage => ({
  type: "request",
  stream,
  port,
  method: "GET",
  path,
  headers: [["host", `localhost:${port}`]],
  ...extra,
});

/** Reads one HTTP response off the tunnel: `head`, body data, `end`. */
const readResponse = (socket: FakeSocket, stream: number) =>
  Effect.gen(function* () {
    const head = yield* nextControl(socket);
    if (head.type !== "head") throw new Error(`Expected head, got ${JSON.stringify(head)}.`);
    expect(head.stream).toBe(stream);
    const chunks: Array<Uint8Array> = [];
    while (true) {
      const frame = yield* next(socket);
      if (frame instanceof Uint8Array) {
        const body = readDataFrame(frame)!;
        expect(body).toMatchObject({ stream, kind: DATA_KIND.body });
        chunks.push(body.payload.slice());
        continue;
      }
      expect(frame).toEqual({ type: "end", stream });
      const headers = new Map(head.headers.map(([name, value]) => [name.toLowerCase(), value]));
      return { status: head.status, headers, chunks, body: Buffer.concat(chunks) };
    }
  });

/** A dev server on an ephemeral port, with a `ws` server on the same port. */
const startServer = (
  host: string,
  handler: NodeHttp.RequestListener,
  onSocket: (socket: NodeWS.WebSocket, request: NodeHttp.IncomingMessage) => void = () => {},
) =>
  Effect.acquireRelease(
    Effect.callback<{
      readonly port: number;
      readonly wss: NodeWS.WebSocketServer;
      readonly server: NodeHttp.Server;
    }>((resume) => {
      const server = NodeHttp.createServer(handler);
      const wss = new NodeWS.WebSocketServer({
        server,
        handleProtocols: (protocols) => (protocols.has("vite-hmr") ? "vite-hmr" : false),
      });
      wss.on("connection", onSocket);
      server.listen(0, host, () =>
        resume(
          Effect.succeed({ port: (server.address() as NodeNet.AddressInfo).port, wss, server }),
        ),
      );
    }),
    ({ server, wss }) =>
      Effect.callback<void>((resume) => {
        for (const client of wss.clients) client.terminate();
        wss.close();
        server.closeAllConnections();
        server.close(() => resume(Effect.void));
      }),
  );

/** Requests read their body, then answer by path. Notes what they saw on `events`. */
const devServer =
  (events: Queue.Queue<string>): NodeHttp.RequestListener =>
  (req, res) => {
    const body: Array<Buffer> = [];
    req.on("data", (chunk: Buffer) => body.push(chunk));
    if (req.url === "/hang") {
      Queue.offerUnsafe(events, "hang:start");
      res.on("close", () => {
        if (!res.writableFinished) Queue.offerUnsafe(events, "hang:closed");
      });
      return;
    }
    req.on("end", () => {
      if (req.url?.startsWith("/echo")) {
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "x-seen-url": req.url,
          "x-seen-encoding": String(req.headers["accept-encoding"]),
          "x-seen-custom": String(req.headers["x-custom"]),
          "x-seen-dropped": `${req.headers["proxy-authorization"]}/${req.headers["x-hop"]}`,
        });
        // Big enough to need several data frames.
        res.end(Buffer.concat([...body, Buffer.alloc(200_000, 7)]));
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`hello from ${req.socket.localAddress}`);
    });
  };

describe("RunnerPreviewTunnel", () => {
  it.live("proxies an HTTP request with a body and a multi-frame response", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<string>();
        const { port } = yield* startServer("127.0.0.1", devServer(events));
        const { thread } = yield* startTunnel([port]);
        const socket = yield* welcome(thread);
        expect(yield* nextControl(socket)).toEqual({
          type: "ports",
          ports: [{ port, processName: "node" }],
        });

        yield* socket.toRunner(
          request(1, port, "/echo?x=1", {
            method: "POST",
            headers: [
              ["host", `localhost:${port}`],
              ["x-custom", "a"],
              ["x-custom", "b"],
              ["accept-encoding", "gzip, br"],
              ["proxy-authorization", "secret"],
              ["connection", "keep-alive, x-hop"],
              ["x-hop", "1"],
            ],
          }),
        );
        yield* socket.toRunner(data(1, DATA_KIND.body, encoder.encode("hello ")));
        yield* socket.toRunner(data(1, DATA_KIND.body, encoder.encode("world")));
        yield* socket.toRunner({ type: "end", stream: 1 });

        const response = yield* readResponse(socket, 1);
        expect(response.status).toBe(200);
        expect(response.headers.get("x-seen-url")).toBe("/echo?x=1");
        expect(response.headers.get("x-seen-encoding")).toBe("gzip, br");
        expect(response.headers.get("x-seen-custom")).toBe("a, b");
        expect(response.headers.get("x-seen-dropped")).toBe("undefined/undefined");
        expect(response.headers.has("transfer-encoding")).toBe(false);
        expect(response.headers.has("connection")).toBe(false);
        expect(response.chunks.length).toBeGreaterThan(1);
        for (const chunk of response.chunks)
          expect(chunk.byteLength).toBeLessThanOrEqual(MAX_DATA_BYTES);
        expect(response.body).toEqual(
          Buffer.concat([Buffer.from("hello world"), Buffer.alloc(200_000, 7)]),
        );
      }),
    ),
  );

  it.live("reaches servers bound to 127.0.0.1 or ::1 alone", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<string>();
        const v4 = yield* startServer("127.0.0.1", devServer(events));
        const v6 = yield* startServer("::1", devServer(events));
        const { thread } = yield* startTunnel([v4.port, v6.port]);
        const socket = yield* welcome(thread);
        yield* nextControl(socket);

        yield* socket.toRunner(request(1, v4.port, "/"));
        yield* socket.toRunner({ type: "end", stream: 1 });
        expect((yield* readResponse(socket, 1)).body.toString()).toBe("hello from 127.0.0.1");

        yield* socket.toRunner(request(2, v6.port, "/"));
        yield* socket.toRunner({ type: "end", stream: 2 });
        expect((yield* readResponse(socket, 2)).body.toString()).toBe("hello from ::1");
      }),
    ),
  );

  it.live("fails streams to a closed or unreported port", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<string>();
        // A port that just had a server on it, so nothing listens there now.
        const closedPort = yield* Effect.scoped(
          Effect.map(startServer("127.0.0.1", devServer(events)), (server) => server.port),
        );
        const { thread } = yield* startTunnel([closedPort]);
        const socket = yield* welcome(thread);
        yield* nextControl(socket);

        yield* socket.toRunner(request(1, closedPort, "/"));
        yield* socket.toRunner({ type: "end", stream: 1 });
        const refused = yield* nextControl(socket);
        expect(refused).toMatchObject({ type: "fail", stream: 1 });
        expect(refused.type === "fail" && refused.message).toContain("ECONNREFUSED");

        yield* socket.toRunner(request(2, closedPort + 1, "/"));
        expect(yield* nextControl(socket)).toEqual({
          type: "fail",
          stream: 2,
          message: `Nothing serves port ${closedPort + 1} here.`,
        });
      }),
    ),
  );

  it.live("aborts cancelled streams and every stream on a drop, then re-reports ports", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<string>();
        const { port } = yield* startServer("127.0.0.1", devServer(events));
        const { thread, setPorts } = yield* startTunnel([port]);
        let socket = yield* welcome(thread);
        yield* nextControl(socket);

        yield* socket.toRunner(request(1, port, "/hang"));
        yield* socket.toRunner({ type: "end", stream: 1 });
        expect(yield* Queue.take(events)).toBe("hang:start");
        yield* socket.toRunner({ type: "cancel", stream: 1 });
        expect(yield* Queue.take(events)).toBe("hang:closed");

        // The cancelled stream says nothing more; the next frame is the next stream's.
        yield* socket.toRunner(request(2, port, "/"));
        yield* socket.toRunner({ type: "end", stream: 2 });
        expect((yield* readResponse(socket, 2)).status).toBe(200);

        yield* socket.toRunner(request(3, port, "/hang"));
        yield* socket.toRunner({ type: "end", stream: 3 });
        expect(yield* Queue.take(events)).toBe("hang:start");
        yield* socket.drop;
        expect(yield* Queue.take(events)).toBe("hang:closed");

        socket = yield* welcome(thread);
        expect(yield* nextControl(socket)).toEqual({
          type: "ports",
          ports: [{ port, processName: "node" }],
        });
        yield* setPorts([]);
        expect(yield* nextControl(socket)).toEqual({ type: "ports", ports: [] });
      }),
    ),
  );

  it.live("proxies a WebSocket both ways and closes it from either side", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<string>();
        const { port } = yield* startServer("127.0.0.1", devServer(events), (ws, req) => {
          Queue.offerUnsafe(
            events,
            `connected ${req.url} x-test=${req.headers["x-test"]} cookie=${req.headers.cookie}`,
          );
          if (req.url === "/server-closes") return ws.close(4001, "server-bye");
          if (req.url === "/big") return ws.send(Buffer.alloc(MAX_WS_MESSAGE_BYTES + 1));
          ws.on("message", (message, isBinary) => ws.send(message, { binary: isBinary }));
          ws.on("close", (code, reason) => Queue.offerUnsafe(events, `closed ${code} ${reason}`));
        });
        const { thread } = yield* startTunnel([port]);
        const socket = yield* welcome(thread);
        yield* nextControl(socket);

        yield* socket.toRunner({
          type: "ws.open",
          stream: 1,
          port,
          path: "/hmr?token=1",
          headers: [
            ["host", `localhost:${port}`],
            ["x-test", "1"],
            ["cookie", "a=1"],
            ["cookie", "b=2"],
            ["sec-websocket-key", "not-this-one"],
            ["sec-websocket-extensions", "permessage-deflate"],
          ],
          protocols: ["vite-hmr"],
        });
        expect(yield* nextControl(socket)).toEqual({
          type: "ws.opened",
          stream: 1,
          protocol: "vite-hmr",
        });
        expect(yield* Queue.take(events)).toBe("connected /hmr?token=1 x-test=1 cookie=a=1; b=2");

        yield* socket.toRunner(data(1, DATA_KIND.wsText, encoder.encode("hi")));
        const text = yield* nextData(socket);
        expect(text.kind).toBe(DATA_KIND.wsText);
        expect(decoder.decode(text.payload)).toBe("hi");

        yield* socket.toRunner(data(1, DATA_KIND.wsBinary, new Uint8Array([0, 1, 2, 255])));
        const binary = yield* nextData(socket);
        expect(binary.kind).toBe(DATA_KIND.wsBinary);
        expect([...binary.payload]).toEqual([0, 1, 2, 255]);

        yield* socket.toRunner({ type: "ws.close", stream: 1, code: 1000, reason: "bye" });
        expect(yield* Queue.take(events)).toBe("closed 1000 bye");

        yield* socket.toRunner({
          type: "ws.open",
          stream: 2,
          port,
          path: "/server-closes",
          headers: [],
          protocols: [],
        });
        expect(yield* nextControl(socket)).toEqual({ type: "ws.opened", stream: 2, protocol: "" });
        expect(yield* nextControl(socket)).toEqual({
          type: "ws.close",
          stream: 2,
          code: 4001,
          reason: "server-bye",
        });

        // A message bigger than one data frame can't cross, so the socket closes.
        yield* socket.toRunner({
          type: "ws.open",
          stream: 3,
          port,
          path: "/big",
          headers: [],
          protocols: [],
        });
        expect(yield* nextControl(socket)).toMatchObject({ type: "ws.opened", stream: 3 });
        expect(yield* nextControl(socket)).toMatchObject({
          type: "ws.close",
          stream: 3,
          code: 1009,
        });
      }),
    ),
  );

  it.live("speaks JSON text for control and binary for data over a real socket", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<string>();
        const { port } = yield* startServer("127.0.0.1", devServer(events));
        // The thread: answers hello, then asks for one page once it has the ports.
        const frames = yield* Queue.unbounded<string | Uint8Array>();
        const cloud = yield* startServer(
          "127.0.0.1",
          (_req, res) => res.writeHead(404).end(),
          (ws, req) => {
            Queue.offerUnsafe(events, `tunnel ${req.url}`);
            ws.on("message", (message: Buffer, isBinary) => {
              if (isBinary) return void Queue.offerUnsafe(frames, new Uint8Array(message));
              const text = message.toString();
              if (text === "ping") return void ws.send("pong");
              Queue.offerUnsafe(frames, text);
              const parsed = tunnelRunnerFrame.decode(text);
              if (parsed.type === "hello") ws.send(tunnelThreadFrame.encode({ type: "welcome" }));
              if (parsed.type === "ports") {
                ws.send(tunnelThreadFrame.encode(request(7, port, "/")));
                ws.send(tunnelThreadFrame.encode({ type: "end", stream: 7 }));
              }
            });
          },
        );
        yield* runPreviewTunnel({
          threadId,
          generation: 3,
          token: "lease-token",
          transport: previewTunnelTransport(
            threadSocketUrl(`http://127.0.0.1:${cloud.port}`, PREVIEW_TUNNEL_PATH, threadId),
          ),
          ports: makePorts([{ port, processName: null }]).source,
        });
        expect(yield* Queue.take(events)).toBe(`tunnel ${PREVIEW_TUNNEL_PATH}?threadId=thread-1`);
        const text = (frame: string | Uint8Array) => {
          if (typeof frame !== "string") throw new Error("Expected a text frame.");
          return tunnelRunnerFrame.decode(frame);
        };
        expect(text(yield* Queue.take(frames))).toMatchObject({ type: "hello", generation: 3 });
        expect(text(yield* Queue.take(frames))).toEqual({
          type: "ports",
          ports: [{ port, processName: null }],
        });
        expect(text(yield* Queue.take(frames))).toMatchObject({
          type: "head",
          stream: 7,
          status: 200,
        });
        const body = yield* Queue.take(frames);
        if (typeof body === "string") throw new Error("Expected a binary frame.");
        expect(readDataFrame(body)).toMatchObject({ stream: 7, kind: DATA_KIND.body });
        expect(decoder.decode(readDataFrame(body)!.payload)).toBe("hello from 127.0.0.1");
        expect(text(yield* Queue.take(frames))).toEqual({ type: "end", stream: 7 });
      }),
    ),
  );

  it.effect("stops for good when the thread refuses the tunnel", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { thread, tunnel } = yield* startTunnel([]);
        const socket = yield* Queue.take(thread.sockets);
        expect(yield* nextControl(socket)).toMatchObject({ type: "hello" });
        yield* socket.toRunner({ type: "refused", message: "A newer generation holds the lease." });
        expect(yield* tunnel.ended).toBe("refused: A newer generation holds the lease.");
        yield* TestClock.adjust("10 minutes");
        expect(yield* Queue.size(thread.sockets)).toBe(0);
      }),
    ),
  );
});
