// @effect-diagnostics nodeBuiltinImport:off - Prove prepared-package resolution and process shutdown over real proxy sockets.
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as Undici from "undici";
import { HttpsProxyAgent } from "https-proxy-agent";
import { expect, it } from "vite-plus/test";
import { inspectNodeHarnessRelease } from "../../InspectNodeHarnessRelease.ts";
import { fixture } from "./fixture.ts";
import { installProxyRuntime } from "./proxyRuntimeFixture.ts";

async function listen(server: NodeHttp.Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  return address.port;
}

it("uses the loaded environment package and drains proxy sockets through the public process lifecycle", async () => {
  const f = fixture();
  const runtime = installProxyRuntime();
  const pendingConnect = Promise.withResolvers<void>();
  const peers = new Set<NodeNet.Socket>();
  const target = NodeHttp.createServer((_request, response) => response.end("runtime fixture"));
  const targetPort = await listen(target);
  let connections = 0;
  const proxy = NodeHttp.createServer();
  proxy.on("connect", (_request, socket, head) => {
    connections++;
    socket.once("end", () => socket.end());
    if (connections === 2) {
      socket.resume();
      pendingConnect.resolve();
      return;
    }
    const upstream = NodeNet.connect(targetPort, "127.0.0.1");
    peers.add(upstream);
    upstream.once("close", () => peers.delete(upstream));
    upstream.once("error", () => socket.destroy());
    socket.once("error", () => upstream.destroy());
    socket.once("close", () => upstream.destroy());
    upstream.once("connect", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
  });
  const proxyPort = await listen(proxy);
  const agent = new HttpsProxyAgent(`http://127.0.0.1:${proxyPort}`);
  let packageLoads = 0;
  try {
    const result = await inspectNodeHarnessRelease(
      {
        ...f.input,
        nativeModules: { ...f.input.nativeModules, http: runtime.http, https: runtime.https },
        loadPackages: async () => {
          packageLoads++;
          return { undici: Undici };
        },
      },
      async (_release, bridge) => {
        const http = bridge.require("http") as typeof NodeHttp;
        const module = bridge.require("module") as typeof import("node:module");
        expect(module.createRequire("/release/cli")("undici")).toBe(Undici);
        const request = http.get(`http://127.0.0.1:${targetPort}/runtime`, { agent });
        const response = await new Promise<NodeHttp.IncomingMessage>((resolve, reject) => {
          request.once("response", resolve);
          request.once("error", reject);
        });
        const chunks: Uint8Array[] = [];
        for await (const chunk of response) chunks.push(chunk);
        const pending = http.get("http://target.fixture.invalid:18443/pending", { agent });
        const cancelled = new Promise<unknown>((resolve) => pending.once("error", resolve));
        await pendingConnect.promise;
        return { body: Buffer.concat(chunks).toString(), pending, cancelled };
      },
    );
    expect(result.body).toBe("runtime fixture");
    expect(packageLoads).toBe(1);
    expect(await result.cancelled).toMatchObject({ code: "ECONNRESET" });
    expect(result.pending.closed).toBe(true);
    expect(runtime.sockets.length).toBeGreaterThan(1);
    expect(runtime.sockets.every((socket) => socket.closed)).toBe(true);
    expect(connections).toBe(2);
  } finally {
    agent.destroy();
    for (const socket of peers) socket.destroy();
    for (const server of [proxy, target]) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
    runtime.restore();
    await f.close();
  }
});
