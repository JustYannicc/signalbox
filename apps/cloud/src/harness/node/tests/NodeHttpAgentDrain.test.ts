// @effect-diagnostics nodeBuiltinImport:off - Exercise shutdown retries through real proxy sockets.
import * as NodeHttp from "node:http";
import * as Undici from "undici";
import { HttpsProxyAgent } from "https-proxy-agent";
import { expect, it } from "vite-plus/test";
import { configureNodeHttpAgents, drainNodeHttpAgents } from "../../../isolate/NodeHttpAgent.ts";
import { installProxyRuntime } from "./proxyRuntimeFixture.ts";

it("refuses retries from cancellation handlers once harness drain starts", async () => {
  const runtime = installProxyRuntime();
  configureNodeHttpAgents([runtime.http, runtime.https], () => Undici);
  const connected = Promise.withResolvers<void>();
  let connections = 0;
  const proxy = NodeHttp.createServer();
  proxy.on("connect", (_request, socket) => {
    connections++;
    socket.once("end", () => socket.end());
    socket.resume();
    connected.resolve();
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const address = proxy.address();
  if (!address || typeof address === "string") throw new Error("Missing proxy port");
  const agent = new HttpsProxyAgent(`http://127.0.0.1:${address.port}`);
  let retry: NodeHttp.ClientRequest | undefined;
  let refused: unknown;
  try {
    const request = runtime.http.get("http://target.fixture.invalid:18443/pending", { agent });
    request.once("error", () => {
      try {
        // Retry on the other protocol to prove admission belongs to the whole realm.
        retry = runtime.https.get("https://target.fixture.invalid:18443/retry", { agent });
        retry.on("error", () => {});
      } catch (error) {
        refused = error;
      }
    });
    await connected.promise;
    await drainNodeHttpAgents([runtime.http, runtime.https]);
    expect(retry?.closed ?? true, "drain left a retry open").toBe(true);
    expect(refused).toMatchObject({ code: "ECONNRESET" });
    expect(retry).toBeUndefined();
    expect(request.closed).toBe(true);
    expect(runtime.sockets.length).toBeGreaterThan(0);
    expect(runtime.sockets.every((socket) => socket.closed)).toBe(true);
    expect(connections).toBe(1);
    expect(() => runtime.http.get("http://target.fixture.invalid/", { agent })).toThrowError(
      expect.objectContaining({ code: "ECONNRESET" }),
    );
  } finally {
    agent.destroy();
    try {
      await drainNodeHttpAgents([runtime.http, runtime.https]);
      proxy.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        proxy.close((error) => (error ? reject(error) : resolve())),
      );
    } finally {
      runtime.restore();
    }
  }
});
