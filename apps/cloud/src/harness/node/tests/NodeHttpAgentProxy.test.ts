// @effect-diagnostics nodeBuiltinImport:off - Exercise the real proxy library and network sockets used by the CLI.
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeNet from "node:net";
import * as NodeFS from "node:fs";
import * as NodeTls from "node:tls";
import { HttpsProxyAgent } from "https-proxy-agent";
import { afterEach, beforeEach, expect, it } from "vite-plus/test";
import { drainNodeHttpAgents } from "../../../isolate/NodeHttpAgent.ts";
import { installProxyRuntime } from "./proxyRuntimeFixture.ts";
import { nodeRootCertificates } from "../../../isolate/NodeTls.ts";

let runtime: ReturnType<typeof installProxyRuntime>;
beforeEach(() => {
  runtime = installProxyRuntime();
});
afterEach(async () => {
  try {
    await drainNodeHttpAgents([runtime.http, runtime.https]);
  } finally {
    runtime.restore();
  }
});

async function listen(server: NodeHttp.Server | NodeHttps.Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  return address.port;
}

async function close(server: NodeHttp.Server | NodeHttps.Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function responseBody(request: {
  once(event: string, callback: (...args: never[]) => void): unknown;
}) {
  const response = await new Promise<NodeHttp.IncomingMessage>((resolve, reject) => {
    request.once("response", resolve);
    request.once("error", reject);
  });
  const chunks: Uint8Array[] = [];
  for await (const chunk of response) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

it("preserves the CLI proxy Agent's CONNECT route, dynamic authorization and direct bypass choice", async () => {
  const connections: Array<{ target: string | undefined; authorization: string | undefined }> = [];
  const observed: Array<{ url: string | undefined; body: string }> = [];
  const sockets = new Set<NodeNet.Socket>();
  const target = NodeHttp.createServer(async (request, response) => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of request) chunks.push(chunk);
    observed.push({ url: request.url, body: Buffer.concat(chunks).toString() });
    expect(request.headers["proxy-authorization"]).toBeUndefined();
    response.end(`response ${observed.length}`);
  });
  const proxy = NodeHttp.createServer();
  proxy.on("connect", (request, socket, head) => {
    connections.push({
      target: request.url,
      authorization: request.headers["proxy-authorization"],
    });
    const address = new URL(`http://${request.url}`);
    const upstream = NodeNet.connect({ host: address.hostname, port: Number(address.port) });
    sockets.add(upstream);
    upstream.once("close", () => sockets.delete(upstream));
    upstream.once("error", () => socket.destroy());
    socket.once("error", () => upstream.destroy());
    socket.once("close", () => upstream.destroy());
    upstream.once("connect", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
  });
  const targetPort = await listen(target);
  const proxyPort = await listen(proxy);
  const modules = runtime;
  let token = "Bearer first-fixture-token";
  const lookups: string[] = [];
  const lookup: NodeNet.LookupFunction = (hostname, options, callback) => {
    lookups.push(hostname);
    if (options.all) callback(null, [{ address: "127.0.0.1", family: 4 }]);
    else callback(null, "127.0.0.1", 4);
  };
  const proxyOptions = {
    lookup,
    headers: () => ({ "Proxy-Authorization": token }),
    ca: nodeRootCertificates([]),
  };
  const agent = new HttpsProxyAgent(`http://proxy.fixture.invalid:${proxyPort}`, proxyOptions);
  try {
    for (const [path, body] of [
      ["/first", "first body"],
      ["/second", "second body"],
    ]) {
      const request = modules.http.request(`http://127.0.0.1:${targetPort}${path}`, {
        method: "POST",
        agent,
      });
      const output = responseBody(request);
      request.end(body);
      expect(await output).toBe(`response ${observed.length}`);
      token = "Bearer second-fixture-token";
    }
    const bypass = modules.http.get(`http://127.0.0.1:${targetPort}/bypass`, {
      agent: new modules.http.Agent(),
    });
    expect(await responseBody(bypass)).toBe("response 3");
    expect(lookups).toEqual(["proxy.fixture.invalid", "proxy.fixture.invalid"]);
    expect(connections).toEqual([
      { target: `127.0.0.1:${targetPort}`, authorization: "Bearer first-fixture-token" },
      { target: `127.0.0.1:${targetPort}`, authorization: "Bearer second-fixture-token" },
    ]);
    expect(observed).toEqual([
      { url: "/first", body: "first body" },
      { url: "/second", body: "second body" },
      { url: "/bypass", body: "" },
    ]);
  } finally {
    agent.destroy();
    for (const socket of sockets) socket.destroy();
    await close(proxy);
    await close(target);
  }
});

it.each(["Agent.destroy", "harness drain"] as const)(
  "%s cancels a pending CONNECT and waits for its socket to close",
  async (operation) => {
    let received!: () => void;
    const connected = new Promise<void>((resolve) => {
      received = resolve;
    });
    let peerClosed: Promise<void> | undefined;
    const proxy = NodeHttp.createServer();
    proxy.on("connect", (_request, socket) => {
      peerClosed = new Promise<void>((resolve) => socket.once("close", resolve));
      socket.once("end", () => socket.end());
      socket.resume();
      received();
    });
    const port = await listen(proxy);
    const modules = runtime;
    const agent = new HttpsProxyAgent(`http://127.0.0.1:${port}`);
    try {
      const request = modules.http.get("http://proxy-target.fixture.invalid:18443/pending", {
        agent,
      });
      const result = responseBody(request).catch((error: unknown) => error);
      const closed = new Promise<void>((resolve) => request.once("close", resolve));
      await connected;
      if (operation === "Agent.destroy") agent.destroy();
      else {
        await drainNodeHttpAgents([modules.http, modules.https]);
        expect(runtime.sockets.every((socket) => socket.closed)).toBe(true);
      }
      await closed;
      expect(runtime.sockets.length).toBeGreaterThan(0);
      expect(runtime.sockets.every((socket) => socket.closed)).toBe(true);
      expect(await result).toMatchObject({ code: "ECONNRESET" });
      await peerClosed;
      expect(request.destroyed).toBe(true);
    } finally {
      agent.destroy();
      await close(proxy);
    }
  },
);

it("returns a proxy authentication failure without forwarding target credentials", async () => {
  const proxy = NodeHttp.createServer();
  const received: string[] = [];
  proxy.on("connect", (request, socket) => {
    received.push(JSON.stringify(request.headers));
    socket.end(
      "HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic\r\nContent-Length: 0\r\n\r\n",
    );
  });
  const port = await listen(proxy);
  const modules = runtime;
  const agent = new HttpsProxyAgent(`http://127.0.0.1:${port}`);
  try {
    const request = modules.http.get("http://proxy-target.fixture.invalid:18443/denied", {
      agent,
      headers: { authorization: "Bearer target-only-fixture-token" },
    });
    const response = await new Promise<NodeHttp.IncomingMessage>((resolve, reject) => {
      request.once("response", resolve);
      request.once("error", reject);
    });
    expect(response.statusCode).toBe(407);
    expect(response.headers["proxy-authenticate"]).toBe("Basic");
    response.resume();
    await new Promise<void>((resolve) => request.once("close", resolve));
    expect(received.join("\n")).not.toContain("target-only-fixture-token");
  } finally {
    agent.destroy();
    await close(proxy);
  }
});

it.each(["http", "https"] as const)(
  "uses platform trust for HTTPS through an %s proxy while the supplied CA stays metadata",
  async (proxyProtocol) => {
    const cert = NodeFS.readFileSync(
      new URL("./fixtures/proxy-tls-cert.pem", import.meta.url),
      "utf8",
    );
    const key = NodeFS.readFileSync(
      new URL("./fixtures/proxy-tls-key.pem", import.meta.url),
      "utf8",
    );
    const previousTrust = NodeTls.getCACertificates("default");
    NodeTls.setDefaultCACertificates([...previousTrust, cert]);
    const target = NodeHttps.createServer({ key, cert }, (request, response) => {
      response.end(`verified ${request.headers.host}`);
    });
    const proxy =
      proxyProtocol === "https" ? NodeHttps.createServer({ key, cert }) : NodeHttp.createServer();
    const sockets = new Set<NodeNet.Socket>();
    const targets: Array<string | undefined> = [];
    const targetPort = await listen(target);
    proxy.on("connect", (request, socket, head) => {
      targets.push(request.url);
      const upstream = NodeNet.connect(targetPort, "127.0.0.1");
      sockets.add(upstream);
      upstream.once("close", () => sockets.delete(upstream));
      upstream.once("error", () => socket.destroy());
      socket.once("error", () => upstream.destroy());
      socket.once("close", () => upstream.destroy());
      upstream.once("connect", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        socket.pipe(upstream).pipe(socket);
      });
    });
    const port = await listen(proxy);
    const modules = runtime;
    const lookup: NodeNet.LookupFunction = (_hostname, options, callback) => {
      if (options.all) callback(null, [{ address: "127.0.0.1", family: 4 }]);
      else callback(null, "127.0.0.1", 4);
    };
    const agentOptions = { ca: [...nodeRootCertificates([])], keepAlive: true, lookup };
    const agent =
      proxyProtocol === "https"
        ? new HttpsProxyAgent(`https://proxy-target.fixture.invalid:${port}`, agentOptions)
        : new HttpsProxyAgent(`http://proxy-target.fixture.invalid:${port}`, agentOptions);
    try {
      const request = modules.https.get(
        `https://proxy-target.fixture.invalid:${targetPort}/trusted`,
        { agent },
      );
      const closed = new Promise<void>((resolve) => request.once("close", resolve));
      expect(await responseBody(request)).toBe(
        `verified proxy-target.fixture.invalid:${targetPort}`,
      );
      await closed;
      expect(targets).toEqual([`proxy-target.fixture.invalid:${targetPort}`]);
    } finally {
      agent.destroy();
      for (const socket of sockets) socket.destroy();
      await close(proxy);
      await close(target);
      NodeTls.setDefaultCACertificates(previousTrust);
    }
  },
);

it.each(
  Object.entries({
    cert: "fixture cert",
    key: "fixture key",
    pfx: new Uint8Array([1]),
    rejectUnauthorized: false,
    checkServerIdentity: () => undefined,
  }),
)(
  "rejects the proxy Agent's unsupported TLS option %s before opening a connection",
  (name, value) => {
    const modules = runtime;
    const agent = new HttpsProxyAgent("http://proxy.fixture.invalid:18443", { [name]: value });
    try {
      expect(() =>
        modules.https.request("https://proxy-target.fixture.invalid/", { agent }),
      ).toThrowError(expect.objectContaining({ code: "ERR_SIGNALBOX_NODE_BUILTIN_UNSUPPORTED" }));
    } finally {
      agent.destroy();
    }
  },
);
