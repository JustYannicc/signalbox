// @effect-diagnostics nodeBuiltinImport:off - verify the real HTTP connection and case admission without workerd.
import * as NodeHttp from "node:http";
import { describe, expect, it } from "@effect/vitest";
import { createStageTransport } from "./stageTransport.ts";

async function withStage(
  run: (fixture: {
    endpoint: string;
    requests: string[];
    connections: Set<NodeHttp.IncomingMessage["socket"]>;
    health: (handler: (response: NodeHttp.ServerResponse) => void) => void;
    closeAfter: (path: string) => void;
    requireSessionReadiness: (session: string) => void;
  }) => Promise<void>,
) {
  const requests: string[] = [];
  const connections = new Set<NodeHttp.IncomingMessage["socket"]>();
  let closeAfter: string | undefined;
  let requiredSession: string | undefined;
  let sessionReady = false;
  let health = (response: NodeHttp.ServerResponse) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ready: true, versionId: "upload", workerName: "127" }));
  };
  const server = NodeHttp.createServer(async (request, response) => {
    requests.push(request.url!);
    if (request.url === closeAfter) response.setHeader("connection", "close");
    if (request.headers.authorization !== "Bearer secret") {
      response.writeHead(401).end();
    } else if (request.url === "/probe/health") {
      health(response);
    } else if (request.url === "/") {
      response.writeHead(400, { "content-type": "text/plain" }).end("Invalid session");
    } else if (request.url === `/probe/session-health?session=${requiredSession}`) {
      sessionReady = true;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ready: true,
          versionId: "upload",
          workerName: "127",
          retainedBytes: 0,
          memoryUsage: {},
          heapStatistics: {},
        }),
      );
    } else if (request.url === `/root/wasm?session=${requiredSession}`) {
      response.writeHead(sessionReady ? 200 : 500, { "content-type": "application/json" });
      response.end(
        JSON.stringify(
          sessionReady ? { ok: true, value: 42 } : { error: "Error: Worker not found." },
        ),
      );
    } else if (request.url?.startsWith("/probe/session-health?session=")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ready: true, versionId: "upload", workerName: "127" }));
    } else if (request.url === "/root/status?session=readiness") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ retainedBytes: 0, memoryUsage: {}, heapStatistics: {} }));
    } else if (request.url === "/upload?session=bytes") {
      const chunks: number[] = [];
      for await (const chunk of request) {
        if (!(chunk instanceof Uint8Array)) throw new Error("Unexpected request body chunk");
        chunks.push(...chunk);
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: 200, result: chunks }));
    } else {
      response.writeHead(404, { "content-type": "text/html" }).end("Page not found");
    }
  });
  server.on("connection", (socket) => connections.add(socket));
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing stage port");
    await run({
      endpoint: `http://127.0.0.1:${address.port}`,
      requests,
      connections,
      health: (handler) => {
        health = handler;
      },
      requireSessionReadiness: (session) => {
        requiredSession = session;
      },
      closeAfter: (path) => {
        closeAfter = path;
      },
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

describe("measurement stage transport", () => {
  it("checks the destination session before its first measurement request", async () => {
    await withStage(async ({ endpoint, requests, requireSessionReadiness }) => {
      requireSessionReadiness("fresh-do");
      const transport = createStageTransport(endpoint, "secret", "upload");
      try {
        const result = await transport.request(
          new URL("/root/wasm?session=fresh-do", endpoint),
          () => ({ headers: { authorization: "Bearer secret" } }),
          true,
        );
        expect(result.response).toEqual({ status: 200, result: { ok: true, value: 42 } });
        expect(requests.filter((path) => path === "/root/wasm?session=fresh-do")).toHaveLength(1);
      } finally {
        await transport.close();
      }
    });
  });

  it("gates every case on the same connection and preserves a case's first failed response", async () => {
    await withStage(async ({ endpoint, requests, connections, health }) => {
      const transport = createStageTransport(endpoint, "secret", "upload");
      const init = { headers: { authorization: "Bearer secret" } };
      try {
        const first = await transport.request(
          new URL("/root/jspi?session=first", endpoint),
          () => init,
          true,
        );
        expect(first.response).toEqual({ status: 404, error: "Page not found" });
        const healthStarted = Promise.withResolvers<NodeHttp.ServerResponse>();
        health((response) => {
          healthStarted.resolve(response);
        });
        let caseStarts = 0;
        const second = transport.request(
          new URL("/root/wasm?session=second", endpoint),
          () => {
            caseStarts++;
            return init;
          },
          true,
        );
        const response = await Promise.race([
          healthStarted.promise,
          second.then(() => {
            throw new Error("Case ran before its stage health check");
          }),
        ]);
        expect(requests.filter((path) => path.includes("session=second"))).toEqual([]);
        expect(caseStarts).toBe(0);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ready: true, versionId: "upload", workerName: "127" }));
        await second;
        expect(caseStarts).toBe(1);
        expect(requests).toEqual([
          "/probe/health",
          "/",
          "/probe/session-health?session=first",
          "/root/jspi?session=first",
          "/probe/health",
          "/",
          "/probe/session-health?session=second",
          "/root/wasm?session=second",
        ]);
        expect(connections.size).toBe(1);
      } finally {
        await transport.close();
      }
    });
  });

  it("does not dispatch a case after health authentication fails", async () => {
    await withStage(async ({ endpoint, requests, health }) => {
      const transport = createStageTransport(endpoint, "secret", "upload");
      health((response) => {
        response.writeHead(401).end();
      });
      try {
        await expect(
          transport.request(new URL("/root/jspi?session=case", endpoint), () => ({})),
        ).rejects.toThrow("unexpected HTTP 401");
        expect(requests).toEqual(["/probe/health"]);
      } finally {
        await transport.close();
      }
    });
  });
  it("preserves a streamed binary case body after readiness", async () => {
    await withStage(async ({ endpoint, requests, connections }) => {
      const transport = createStageTransport(endpoint, "secret", "upload");
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([0, 255]));
          controller.enqueue(new Uint8Array([13, 10, 128]));
          controller.close();
        },
      });
      const init: RequestInit & { duplex: "half" } = {
        method: "POST",
        headers: { authorization: "Bearer secret", "content-type": "application/octet-stream" },
        body,
        duplex: "half",
      };
      try {
        const result = await transport.request(
          new URL("/upload?session=bytes", endpoint),
          () => init,
        );
        expect(result.response).toEqual({ status: 200, result: [0, 255, 13, 10, 128] });
        expect(requests).toEqual([
          "/probe/health",
          "/",
          "/probe/session-health?session=bytes",
          "/upload?session=bytes",
        ]);
        expect(connections.size).toBe(1);
      } finally {
        await transport.close();
      }
    });
  });
  it.each(["/probe/health", "/", "/probe/session-health?session=never-started"])(
    "fails setup before sending a case when %s closes the checked connection",
    async (path) => {
      await withStage(async ({ endpoint, requests, closeAfter }) => {
        const transport = createStageTransport(endpoint, "secret", "upload");
        closeAfter(path);
        try {
          await expect(
            transport.request(
              new URL("/root/jspi?session=never-started", endpoint),
              () => ({ headers: { authorization: "Bearer secret" } }),
              true,
            ),
          ).rejects.toThrow("stage connection changed before case dispatch");
          expect(requests).not.toContain("/root/jspi?session=never-started");
        } finally {
          await transport.close();
        }
      });
    },
  );
});
