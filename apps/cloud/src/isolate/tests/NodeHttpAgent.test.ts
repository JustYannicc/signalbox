// @effect-diagnostics nodeBuiltinImport:off - Exercise the Agent against a real Node HTTP fixture.
import * as NodeHttp from "node:http";
import type * as NodeEvents from "node:events";
import * as NodeHttps from "node:https";
import { describe, expect, it } from "vite-plus/test";
import { createNodeHttpAgentModules } from "../NodeHttpAgent.ts";
import { nodeRootCertificates } from "../NodeTls.ts";

function fixture() {
  const diagnostics: string[] = [];
  const modules = createNodeHttpAgentModules({ http: NodeHttp, https: NodeHttps }, (message) =>
    diagnostics.push(message),
  );
  return { ...modules, diagnostics };
}

async function readResponse(request: NodeEvents.EventEmitter) {
  const response = await new Promise<NodeHttp.IncomingMessage>((resolve, reject) => {
    request.once("response", resolve);
    request.once("error", reject);
  });
  const chunks: Uint8Array[] = [];
  for await (const chunk of response) chunks.push(chunk);
  return { status: response.statusCode, body: Buffer.concat(chunks).toString() };
}

describe("platform HTTP Agents", () => {
  it("accepts the CLI's default filtered CA options and emits one bounded policy diagnostic", () => {
    const { http, https, diagnostics } = fixture();
    const ca = nodeRootCertificates([]).slice(1);
    const agent = new https.Agent({ ca, keepAlive: true });
    const fresh = new https.Agent({ ca, keepAlive: false });
    const plain = new http.Agent({ keepAlive: true, maxSockets: 4 });
    expect(fresh.keepAlive).toBe(false);
    expect(plain.maxSockets).toBe(4);
    expect(agent.options.ca).toBe(ca);
    expect(agent.protocol).toBe("https:");
    expect(agent.defaultPort).toBe(443);
    expect(
      diagnostics.filter((message) => message === "CA policy supplied, platform trust enforced"),
    ).toHaveLength(1);
    expect(
      diagnostics.filter((message) => message.includes("platform fetch controls pooling")),
    ).toHaveLength(1);
    expect(diagnostics.join("\n")).not.toContain("BEGIN CERTIFICATE");
  });

  const refused = Object.entries({
    cert: "certificate",
    key: "private key",
    pfx: new Uint8Array([1]),
    rejectUnauthorized: false,
    checkServerIdentity: () => undefined,
    proxy: "http://proxy.invalid:8080",
    socketPath: "/fixture.sock",
  });
  const cases = (["http", "https"] as const).flatMap((protocol) =>
    refused.map(([name, value]) => ({ protocol, name, value })),
  );
  it.each(cases)(
    "rejects $protocol $name at construction and request time",
    ({ protocol, name, value }) => {
      const module = fixture()[protocol];
      expect(() => new module.Agent({ [name]: value })).toThrowError(
        expect.objectContaining({
          code: "ERR_SIGNALBOX_NODE_BUILTIN_UNSUPPORTED",
          builtin: `${protocol}.Agent option ${name}`,
        }),
      );
      const agent = new module.Agent();
      expect(() =>
        module.request(`${protocol}://fixture.invalid:8443/path`, { agent, [name]: value }),
      ).toThrowError(
        expect.objectContaining({
          code: "ERR_SIGNALBOX_NODE_BUILTIN_UNSUPPORTED",
          builtin: `${protocol}.request option ${name}`,
        }),
      );
      agent.options[name] = value;
      expect(() => module.get(`${protocol}://fixture.invalid/`, { agent })).toThrowError(
        expect.objectContaining({ code: "ERR_SIGNALBOX_NODE_BUILTIN_UNSUPPORTED" }),
      );
    },
  );

  it("sends the selected host, port, path, method, headers and body through the platform client", async () => {
    const { http } = fixture();
    const server = NodeHttp.createServer(async (request, response) => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of request) chunks.push(chunk);
      response.writeHead(201, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          method: request.method,
          url: request.url,
          host: request.headers.host,
          authorization: request.headers.authorization,
          body: Buffer.concat(chunks).toString(),
        }),
      );
    });
    server.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture port");
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1, timeout: 5000 });
    try {
      const request = http.request(`http://user:pass@127.0.0.1:${address.port}/fixture?q=yes`, {
        agent,
        method: "POST",
      });
      const response = readResponse(request);
      request.write("first ");
      request.end("second");
      const result = await response;
      expect(result.status).toBe(201);
      expect(JSON.parse(result.body)).toEqual({
        method: "POST",
        url: "/fixture?q=yes",
        host: `127.0.0.1:${address.port}`,
        authorization: "Basic dXNlcjpwYXNz",
        body: "first second",
      });
      await new Promise<void>((resolve) => request.once("close", resolve));
    } finally {
      agent.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("destroy cancels an active request, and the Agent can be used again", async () => {
    const { http } = fixture();
    const server = NodeHttp.createServer((request, response) => {
      if (request.url === "/second") response.end("resumed");
      else response.flushHeaders();
    });
    server.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture port");
    const agent = new http.Agent();
    try {
      const request = http.get(`http://127.0.0.1:${address.port}/first`, { agent });
      const response = await new Promise<NodeHttp.IncomingMessage>((resolve, reject) => {
        request.once("response", resolve);
        request.once("error", reject);
      });
      response.on("error", () => {});
      const closed = new Promise<void>((resolve) => request.once("close", resolve));
      agent.destroy();
      await closed;
      expect(request.destroyed).toBe(true);
      expect(response.destroyed).toBe(true);
      expect(
        await readResponse(http.get(`http://127.0.0.1:${address.port}/second`, { agent })),
      ).toEqual({ status: 200, body: "resumed" });
    } finally {
      agent.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
