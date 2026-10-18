// @effect-diagnostics nodeBuiltinImport:off - Compare facade constructors with the public Node HTTP API.
import * as NodeBuffer from "node:buffer";
import * as NodeEvents from "node:events";
import * as NodeHttp from "node:http";
import * as NodeTls from "node:tls";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { createHttpClientExports } from "../node/network/HttpClient.ts";
import { addRequestMarker } from "../node/network/HttpRequestCancellation.ts";
import { createNodeNetworkModules, LoopbackRegistry } from "../NodeNetwork.ts";

const nativeTlsConnect = vi.hoisted(() => vi.fn((...args: unknown[]) => args));

vi.mock("node:tls", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeTls>();
  return { ...actual, connect: nativeTlsConnect };
});

interface SocketLike {
  readonly remotePort?: number;
  write(chunk: Uint8Array, callback?: (error?: Error | null) => void): boolean;
  end(chunk?: Uint8Array): void;
  destroy(error?: Error): this;
  on(event: string, listener: (...args: unknown[]) => void): this;
  once(event: string, listener: (...args: unknown[]) => void): this;
}

interface ServerLike {
  readonly listening: boolean;
  readonly connections: number;
  listen(...args: unknown[]): this;
  address(): { readonly port: number } | null;
  close(callback?: (error?: Error | null) => void): this;
  on(event: string, listener: (...args: unknown[]) => void): this;
  once(event: string, listener: (...args: unknown[]) => void): this;
  emit(event: string, ...args: unknown[]): boolean;
}

interface NetModule {
  createServer(
    optionsOrListener?: { readonly allowHalfOpen?: boolean } | ((socket: SocketLike) => void),
    listener?: (socket: SocketLike) => void,
  ): ServerLike;
  connect(port: number, host: string): SocketLike;
}

function createNetwork() {
  return createNodeNetworkModules({
    httpServerHandler: () => ({ fetch: async () => new Response("unused") }),
    connectSocket: () => {
      throw new Error("The test only uses local sockets");
    },
  });
}

function createLocalHttpClient(fetch: (request: Request) => Response | Promise<Response>) {
  const registry = new LoopbackRegistry();
  const server = new NodeEvents.EventEmitter();
  registry.reserve(8080, "http", server, "127.0.0.1");
  return createHttpClientExports(
    "http",
    registry,
    () => ({ fetch }),
    undefined,
    undefined,
    NodeHttp,
  );
}

function event(
  emitter: { once(event: string, listener: (...args: unknown[]) => void): unknown },
  name: string,
): Promise<unknown[]> {
  return new Promise((resolve) => emitter.once(name, (...args) => resolve(args)));
}

describe("Node network bridge", () => {
  it("classifies TLS overloads using Node option precedence without normalizing native args", () => {
    expect(NodeTls.connect).toBe(nativeTlsConnect);
    const tls = createNetwork().tls as { connect(...args: unknown[]): unknown };
    nativeTlsConnect.mockClear();

    const remoteOptions = { host: "example.com" };
    const remoteOverrideArgs = [443, "127.0.0.1", remoteOptions] as const;
    expect(tls.connect(...remoteOverrideArgs)).toEqual([...remoteOverrideArgs]);
    expect(nativeTlsConnect.mock.calls).toHaveLength(1);
    expect(nativeTlsConnect.mock.calls[0]?.[2]).toBe(remoteOptions);

    nativeTlsConnect.mockClear();
    let localOverrideError: unknown;
    try {
      tls.connect(443, "example.com", { host: "127.0.0.1" });
    } catch (error) {
      localOverrideError = error;
    }
    expect(localOverrideError).toMatchObject({ code: "ENOTSUP" });
    expect(nativeTlsConnect).not.toHaveBeenCalled();

    nativeTlsConnect.mockClear();
    const thirdOptions = { host: "example.com" };
    const undefinedMiddleArgs = [443, undefined, thirdOptions] as const;
    expect(tls.connect(...undefinedMiddleArgs)).toEqual([...undefinedMiddleArgs]);
    expect(nativeTlsConnect.mock.calls).toHaveLength(1);
    expect(nativeTlsConnect.mock.calls[0]?.[1]).toBeUndefined();
    expect(nativeTlsConnect.mock.calls[0]?.[2]).toBe(thirdOptions);

    nativeTlsConnect.mockClear();
    let localPathError: unknown;
    try {
      tls.connect("/tmp/local.sock", { host: "example.com" });
    } catch (error) {
      localPathError = error;
    }
    expect(localPathError).toMatchObject({ code: "ENOTSUP" });
    expect(nativeTlsConnect).not.toHaveBeenCalled();

    nativeTlsConnect.mockClear();
    const pathOverrideOptions = { path: undefined, host: "example.com" };
    const pathOverrideArgs = ["/tmp/local.sock", pathOverrideOptions] as const;
    expect(tls.connect(...pathOverrideArgs)).toEqual([...pathOverrideArgs]);
    expect(nativeTlsConnect.mock.calls).toHaveLength(1);
    expect(nativeTlsConnect.mock.calls[0]?.[1]).toBe(pathOverrideOptions);
  });

  it("keeps the exported request and message constructors Node-compatible", () => {
    const modules = createNetwork();

    expect(Reflect.get(modules.http, "ClientRequest")).toBe(NodeHttp.ClientRequest);
    expect(Reflect.get(modules.http, "IncomingMessage")).toBe(NodeHttp.IncomingMessage);
    expect(Reflect.get(modules.https, "ClientRequest")).toBeUndefined();
    expect(Reflect.get(modules.https, "IncomingMessage")).toBeUndefined();
  });

  it("allocates one ephemeral namespace and protects a new owner from stale release", () => {
    const registry = new LoopbackRegistry();
    const netOwner = {};
    const httpOwner = {};
    const first = registry.reserve(0, "net", netOwner, "127.0.0.1");
    expect(first.port).toBeGreaterThanOrEqual(49_152);
    expect(registry.reserve(0, "http", httpOwner, "127.0.0.1").port).not.toBe(first.port);
    let conflict: unknown;
    try {
      registry.reserve(first.port, "https", httpOwner, "127.0.0.1");
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toMatchObject({ code: "EADDRINUSE" });

    expect(registry.release(first)).toBe(true);
    const replacement = registry.reserve(first.port, "https", {}, "127.0.0.1");
    expect(registry.release(first)).toBe(false);
    expect(registry.get(first.port)).toBe(replacement);
  });

  it("streams binary data with half-close and backpressure across local net sockets", async () => {
    const net = createNetwork().net as NetModule;
    const server = net.createServer({ allowHalfOpen: true }, (socket) => {
      socket.once("end", () => socket.end(NodeBuffer.Buffer.from([0, 255, 1])));
    });
    server.listen(0);
    await event(server, "listening");
    const port = server.address()!.port;
    const accepted = event(server, "connection").then(([socket]) => socket as SocketLike);
    const client = net.connect(port, "127.0.0.1");
    const clientConnected = event(client, "connect");
    const serverSocket = await accepted;
    await clientConnected;

    const payload = Uint8Array.from({ length: 32 * 1024 }, (_, index) => index % 256);
    let writeFinished = false;
    const writeFinishedPromise = new Promise<void>((resolve, reject) => {
      client.write(payload, (error) => {
        if (error) reject(error);
        else {
          writeFinished = true;
          resolve();
        }
      });
    });
    await Promise.resolve();
    expect(writeFinished).toBe(false);

    const received: Uint8Array[] = [];
    serverSocket.on("data", (chunk) => received.push(new Uint8Array(chunk as Uint8Array)));
    await writeFinishedPromise;
    expect(NodeBuffer.Buffer.concat(received).equals(NodeBuffer.Buffer.from(payload))).toBe(true);

    const reply: Uint8Array[] = [];
    const replyDone = event(client, "end");
    client.on("data", (chunk) => reply.push(new Uint8Array(chunk as Uint8Array)));
    client.end();
    await replyDone;
    expect(Array.from(NodeBuffer.Buffer.concat(reply))).toEqual([0, 255, 1]);
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("cancels both ends of a local raw socket pair", async () => {
    const net = createNetwork().net as NetModule;
    const server = net.createServer((socket) => socket.on("error", () => {}));
    server.listen(0);
    await event(server, "listening");
    const accepted = event(server, "connection").then(([socket]) => socket as SocketLike);
    const client = net.connect(server.address()!.port, "localhost");
    const serverSocket = await accepted;
    const serverClosed = event(serverSocket, "close");
    client.destroy();
    await serverClosed;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("closes an outbound socket destroyed before its connection opens", async () => {
    let resolveOpened!: (opened: {
      readonly localAddress?: string | null;
      readonly remoteAddress?: string | null;
    }) => void;
    const opened = new Promise<{
      readonly localAddress?: string | null;
      readonly remoteAddress?: string | null;
    }>((resolve) => {
      resolveOpened = resolve;
    });
    let closeCalls = 0;
    const modules = createNodeNetworkModules({
      httpServerHandler: () => ({ fetch: async () => new Response("unused") }),
      connectSocket: () => ({
        opened,
        readable: new ReadableStream<Uint8Array>(),
        writable: new WritableStream<Uint8Array>(),
        close: () => {
          closeCalls += 1;
        },
      }),
    });
    const socket = (modules.net as NetModule).connect(443, "example.com");
    const socketClosed = event(socket, "close");
    socket.destroy();
    await socketClosed;

    resolveOpened({ localAddress: "127.0.0.1:49152", remoteAddress: "93.184.216.34:443" });
    await opened;

    expect(closeCalls).toBe(1);
    expect(socket.remotePort).toBeUndefined();
  });

  it("reports TLS upgrades over an existing remote facet socket as unsupported", async () => {
    const modules = createNodeNetworkModules({
      httpServerHandler: () => ({ fetch: async () => new Response("unused") }),
      connectSocket: () => ({
        opened: Promise.resolve({
          localAddress: "192.0.2.2:49152",
          remoteAddress: "93.184.216.34:443",
        }),
        readable: new ReadableStream<Uint8Array>(),
        writable: new WritableStream<Uint8Array>(),
        close: () => {},
      }),
    });
    const socket = (modules.net as NetModule).connect(443, "example.com");
    await event(socket, "connect");
    const tls = modules.tls as { connect(...args: unknown[]): unknown };
    const errors: unknown[] = [];
    for (const args of [[{ socket }], [socket], [443, "example.com", { socket }]]) {
      try {
        tls.connect(...args);
      } catch (error) {
        errors.push(error);
      }
    }

    expect(errors).toHaveLength(3);
    for (const error of errors) {
      expect(error).toMatchObject({ code: "ENOTSUP" });
      expect((error as Error).message).toContain("TLS upgrades over existing Node sockets");
      expect((error as Error).message).not.toContain("loopback");
    }
    const closed = event(socket, "close");
    socket.destroy();
    await closed;
  });

  it("starts a pending read on open and delivers the queued final chunk before EOF", async () => {
    let resolveOpened!: (opened: {
      readonly localAddress?: string | null;
      readonly remoteAddress?: string | null;
    }) => void;
    const opened = new Promise<{
      readonly localAddress?: string | null;
      readonly remoteAddress?: string | null;
    }>((resolve) => {
      resolveOpened = resolve;
    });
    const payload = Uint8Array.from([0, 255, 1]);
    const modules = createNodeNetworkModules({
      httpServerHandler: () => ({ fetch: async () => new Response("unused") }),
      connectSocket: () => ({
        opened,
        readable: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(payload);
            controller.close();
          },
        }),
        writable: new WritableStream<Uint8Array>(),
        close: () => {},
      }),
    });
    const socket = (modules.net as NetModule).connect(443, "example.com");
    const received: Uint8Array[] = [];
    socket.on("data", (chunk) => received.push(new Uint8Array(chunk as Uint8Array)));
    const ended = event(socket, "end");
    await new Promise<void>((resolve) => process.nextTick(resolve));
    resolveOpened({ localAddress: "192.0.2.2:49152", remoteAddress: "93.184.216.34:443" });

    await ended;
    expect(NodeBuffer.Buffer.concat(received).equals(NodeBuffer.Buffer.from(payload))).toBe(true);
    await event(socket, "close");
  });

  it("keeps separate Set-Cookie values in raw and parsed response headers", async () => {
    const client = createLocalHttpClient(() => {
      const headers = new Headers();
      headers.append("set-cookie", "a=1; Path=/");
      headers.append("set-cookie", "b=2; Path=/");
      return new Response(null, { headers });
    });
    const request = client.request({ host: "127.0.0.1", port: 8080, path: "/cookies" });
    const responsePromise = event(request, "response");
    request.end();

    const [response] = (await responsePromise) as [NodeHttp.IncomingMessage];
    expect(response.headers["set-cookie"]).toEqual(["a=1; Path=/", "b=2; Path=/"]);
    expect(response.headersDistinct["set-cookie"]).toEqual(["a=1; Path=/", "b=2; Path=/"]);
    const rawCookies: string[] = [];
    for (let index = 0; index + 1 < response.rawHeaders.length; index += 2) {
      if (response.rawHeaders[index]!.toLowerCase() === "set-cookie")
        rawCookies.push(response.rawHeaders[index + 1]!);
    }
    expect(rawCookies).toEqual(["a=1; Path=/", "b=2; Path=/"]);
    const ended = event(response, "end");
    response.resume();
    await ended;
  });

  it("refreshes request inactivity only when response chunks are read", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let pulls = 0;
    const client = createLocalHttpClient(
      () =>
        new Response(
          new ReadableStream<Uint8Array>(
            {
              start: (value) => {
                controller = value;
              },
              pull: () => {
                pulls += 1;
              },
            },
            { highWaterMark: 0 },
          ),
        ),
    );
    vi.useFakeTimers();
    try {
      const request = client.request({
        host: "127.0.0.1",
        port: 8080,
        path: "/stream",
        timeout: 10,
      });
      let timedOut = false;
      request.once("timeout", () => {
        timedOut = true;
      });
      const responsePromise = event(request, "response");
      request.end();
      const [response] = (await responsePromise) as [NodeHttp.IncomingMessage];

      expect(pulls).toBe(0);
      await vi.advanceTimersByTimeAsync(9);
      expect(timedOut).toBe(false);
      const firstChunk = event(response, "data");
      controller.enqueue(Uint8Array.of(1));
      await firstChunk;
      expect(pulls).toBeGreaterThan(0);
      await vi.advanceTimersByTimeAsync(9);
      expect(timedOut).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(timedOut).toBe(true);
      request.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets a host install a body reader before it begins pulling", async () => {
    let reader!: ReadableStreamDefaultReader<Uint8Array>;
    let resolveFetch!: (response: Response) => void;
    let markFetchEntered!: () => void;
    const fetchEntered = new Promise<void>((resolve) => {
      markFetchEntered = resolve;
    });
    const client = createLocalHttpClient((request) => {
      reader = request.body!.getReader();
      markFetchEntered();
      return new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });
    });
    const request = client.request({
      host: "127.0.0.1",
      port: 8080,
      path: "/streamed-post",
      method: "POST",
    });
    const payload = Uint8Array.of(0, 255, 1, 2);
    const firstWrite = new Promise<void>((resolve, reject) => {
      request.write(payload, (error) => (error ? reject(error) : resolve()));
    });
    await fetchEntered;
    await firstWrite;

    const first = await reader.read();
    expect(Array.from(first.value ?? [])).toEqual(Array.from(payload));
    const finished = event(request, "finish");
    request.end();
    await finished;
    expect((await reader.read()).done).toBe(true);

    const responsePromise = event(request, "response");
    resolveFetch(new Response("accepted"));
    const [response] = (await responsePromise) as [NodeHttp.IncomingMessage];
    const responseEnded = event(response, "end");
    response.resume();
    await responseEnded;
  }, 1_500);

  it("routes concurrent cancellation to the request that carried its marker", async () => {
    const registry = new LoopbackRegistry();
    const server = new NodeEvents.EventEmitter();
    registry.reserve(8080, "http", server, "127.0.0.1");
    const pending = new Map<
      string,
      { readonly request: Request; readonly resolve: (response: Response) => void }
    >();
    const client = createHttpClientExports(
      "http",
      registry,
      () => ({
        fetch: (request) =>
          new Promise<Response>((resolve) =>
            pending.set(new URL(request.url).pathname, { request, resolve }),
          ),
      }),
      undefined,
      undefined,
      NodeHttp,
    );
    const first = client.request({ host: "127.0.0.1", port: 8080, path: "/first" });
    const second = client.request({ host: "127.0.0.1", port: 8080, path: "/second" });
    first.end();
    second.end();

    type CapturedRequest = {
      incoming: NodeEvents.EventEmitter & {
        headers: Record<string, string>;
        headersDistinct: Record<string, string[]>;
        rawHeaders: string[];
        destroyed: boolean;
        destroy(error?: Error): void;
      };
      outgoing: NodeEvents.EventEmitter & { destroyed: boolean; destroy(error?: Error): void };
    };
    const captured = new Map<string, CapturedRequest>();
    const dispatch = (path: string): void => {
      const entry = pending.get(path);
      if (!entry) throw new Error(`No local request is waiting for ${path}`);
      const headers = Object.create(null) as Record<string, string>;
      const rawHeaders: string[] = [];
      for (const [name, value] of entry.request.headers) {
        headers[name] = value;
        rawHeaders.push(name, value);
      }
      if (path === "/collision-first") {
        const markerIndex = rawHeaders.findIndex(
          (name, index) => name.startsWith("x-signalbox-local-") && rawHeaders[index + 1] !== "1",
        );
        if (markerIndex < 0) throw new Error("No opaque request marker was found");
        rawHeaders.push(rawHeaders[markerIndex]!, "preserve-this-value");
      }
      const headerCount = rawHeaders.length / 2;
      let headersDistinctCache: Record<string, string[]> | undefined;
      const incoming = Object.assign(new NodeEvents.EventEmitter(), {
        headers,
        rawHeaders,
        destroyed: false,
      }) as CapturedRequest["incoming"];
      Object.defineProperty(incoming, "headersDistinct", {
        get: () => {
          if (headersDistinctCache) return headersDistinctCache;
          const distinct = Object.create(null) as Record<string, string[]>;
          for (let index = 0; index < headerCount; index += 1) {
            const name = incoming.rawHeaders[index * 2]!.toLowerCase();
            const value = incoming.rawHeaders[index * 2 + 1]!;
            const values = distinct[name];
            if (values) values.push(value);
            else distinct[name] = [value];
          }
          headersDistinctCache = distinct;
          return distinct;
        },
      });
      incoming.destroy = (error) => {
        incoming.destroyed = true;
        incoming.emit("aborted", error);
        incoming.emit("close");
      };
      const outgoing = Object.assign(new NodeEvents.EventEmitter(), {
        destroyed: false,
      }) as CapturedRequest["outgoing"];
      outgoing.destroy = () => {
        outgoing.destroyed = true;
        outgoing.emit("close");
      };
      server.emit("request", incoming, outgoing);
      captured.set(path, { incoming, outgoing });
    };

    expect(pending.size).toBe(2);
    dispatch("/first");
    dispatch("/second");
    for (const { incoming } of captured.values()) {
      expect(
        Object.keys(incoming.headers).some((name) => name.startsWith("x-signalbox-local-")),
      ).toBe(false);
      expect(
        incoming.rawHeaders.some((name) => name.toLowerCase().startsWith("x-signalbox-local-")),
      ).toBe(false);
      expect(
        Object.keys(incoming.headersDistinct).some((name) => name.startsWith("x-signalbox-local-")),
      ).toBe(false);
    }

    first.destroy();
    expect(captured.get("/first")?.incoming.destroyed).toBe(true);
    expect(captured.get("/first")?.outgoing.destroyed).toBe(true);
    expect(captured.get("/second")?.incoming.destroyed).toBe(false);
    expect(captured.get("/second")?.outgoing.destroyed).toBe(false);
    second.destroy();

    const probeMarker = addRequestMarker(new Headers());
    const sequence = BigInt(probeMarker.name.slice("x-signalbox-local-".length));
    const callerHeaderName = `x-signalbox-local-${sequence + 2n}`;
    const collisionFirst = client.request({
      host: "127.0.0.1",
      port: 8080,
      path: "/collision-first",
      headers: { [callerHeaderName]: "1" },
    });
    const collisionSecond = client.request({
      host: "127.0.0.1",
      port: 8080,
      path: "/collision-second",
    });
    collisionFirst.end();
    collisionSecond.end();
    expect(pending.has("/collision-first")).toBe(true);
    expect(pending.has("/collision-second")).toBe(true);
    dispatch("/collision-first");
    dispatch("/collision-second");

    const collisionFirstIncoming = captured.get("/collision-first")!.incoming;
    const collisionFirstMarker = [...pending.get("/collision-first")!.request.headers].find(
      ([name]) => name.startsWith("x-signalbox-local-") && name !== callerHeaderName,
    );
    if (!collisionFirstMarker) throw new Error("No opaque request marker was found");
    const [collisionFirstMarkerName, collisionFirstMarkerValue] = collisionFirstMarker;
    const collisionSecondIncoming = captured.get("/collision-second")!.incoming;
    expect(collisionFirstIncoming.headers[callerHeaderName]).toBe("1");
    expect(collisionFirstIncoming.headersDistinct[callerHeaderName]).toEqual(["1"]);
    expect(
      collisionFirstIncoming.rawHeaders.some(
        (name, index, headers) =>
          name.toLowerCase() === callerHeaderName && headers[index + 1] === "1",
      ),
    ).toBe(true);
    expect(collisionFirstIncoming.headers[collisionFirstMarkerName]).toBeUndefined();
    expect(collisionFirstIncoming.headersDistinct[collisionFirstMarkerName]).toEqual([
      "preserve-this-value",
    ]);
    expect(
      collisionFirstIncoming.rawHeaders.some(
        (name, index, headers) =>
          name.toLowerCase() === collisionFirstMarkerName &&
          headers[index + 1] === "preserve-this-value",
      ),
    ).toBe(true);
    expect(collisionFirstIncoming.rawHeaders).not.toContain(collisionFirstMarkerValue);
    expect(collisionFirstIncoming.headersDistinct[collisionFirstMarkerName]).not.toContain(
      collisionFirstMarkerValue,
    );
    expect(collisionSecondIncoming.headers[callerHeaderName]).toBeUndefined();

    const collisionSecondClosed = event(collisionSecond, "close");
    collisionSecond.destroy();
    await collisionSecondClosed;
    expect(collisionFirstIncoming.destroyed).toBe(false);
    expect(captured.get("/collision-first")?.outgoing.destroyed).toBe(false);
    expect(collisionSecondIncoming.destroyed).toBe(true);
    expect(captured.get("/collision-second")?.outgoing.destroyed).toBe(true);

    for (const entry of pending.values()) entry.resolve(new Response("ignored"));
    await Promise.resolve();
    await Promise.resolve();
  }, 1_500);
});
