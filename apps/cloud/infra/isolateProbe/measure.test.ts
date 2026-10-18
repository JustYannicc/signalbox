// @effect-diagnostics nodeBuiltinImport:off - run the native probe CLI against an owned HTTP endpoint.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import {
  decodeModuleTransport,
  MODULE_TRANSPORT_CONTENT_TYPE,
  openModuleTransport,
} from "./moduleTransport.ts";

describe("fixture measurement CLI", () => {
  it("uploads every full map and records original inventory plus partial HTTP failures", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "isolate-fixture-"));
    const requests: Awaited<ReturnType<typeof decodeModuleTransport>>[] = [];
    const failures: unknown[] = [];
    const server = NodeHttp.createServer(async (request, response) => {
      try {
        expect(request.headers.authorization).toBe("Bearer fixture-test");
        expect(request.headers["content-type"]).toBe(MODULE_TRANSPORT_CONTENT_TYPE);
        const iterator = request[Symbol.asyncIterator]();
        const stream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            const next = await iterator.next();
            if (next.done) controller.close();
            else if (next.value instanceof Uint8Array) controller.enqueue(next.value);
            else controller.error(new Error("Unexpected HTTP chunk"));
          },
          async cancel() {
            await iterator.return?.();
          },
        });
        requests.push(await decodeModuleTransport(stream));
        if (requests.length === 2) {
          response.writeHead(503);
          response.end("fixture temporarily unavailable");
        } else {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ status: 200, result: { ok: true } }));
        }
      } catch (error) {
        failures.push(error);
        response.writeHead(500);
        response.end("test failed");
      }
    });
    try {
      const source = new TextEncoder().encode("\uFEFFexport default {}; // Grüezi 🌍\r\n");
      const wasm = new Uint8Array([0, 97, 115, 109, 0, 127, 128, 255]);
      await NodeFSP.writeFile(NodePath.join(dir, "source.js"), source);
      await NodeFSP.writeFile(NodePath.join(dir, "binary.wasm"), wasm);
      await NodeFSP.writeFile(
        NodePath.join(dir, "manifest.json"),
        JSON.stringify({
          id: "fixture",
          mainModule: "nested/main.js",
          entrypoint: "ProbeFacet",
          modules: {
            "nested/main.js": { path: "source.js", type: "js" },
            "nested/engine.wasm": { path: "binary.wasm", type: "wasm" },
          },
          paths: ["/first", "/fails", "/last"],
        }),
      );
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing HTTP port");
      const output = NodePath.join(dir, "evidence.json");
      const result = await new Promise<{
        code: string | number | undefined;
        stdout: string;
        stderr: string;
      }>((resolve) => {
        NodeChildProcess.execFile(
          process.execPath,
          [
            NodePath.join(import.meta.dirname, "measure.ts"),
            "--url",
            `http://127.0.0.1:${address.port}`,
            "--fixture",
            dir,
            "--output",
            output,
          ],
          { env: { ...process.env, PROBE_SECRET: "fixture-test" }, timeout: 45000 },
          (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }),
        );
      });
      expect(failures).toEqual([]);
      expect(result.code, result.stderr).toBe(1);
      expect(requests).toHaveLength(3);
      const firstInput = requests[0]?.input;
      if (!firstInput || typeof firstInput !== "object" || !("id" in firstInput))
        throw new Error("Missing fixture input");
      expect(firstInput.id).toMatch(/^[a-f0-9]+-fixture$/);
      for (const [index, request] of requests.entries()) {
        expect(request.input).toMatchObject({
          id: firstInput.id,
          mode: "facet",
          allowOutbound: false,
          mainModule: "nested/main.js",
          entrypoint: "ProbeFacet",
          path: ["/first", "/fails", "/last"][index],
        });
        expect(request.modules).toEqual({
          "nested/main.js": { js: new TextDecoder("utf-8", { ignoreBOM: true }).decode(source) },
          "nested/engine.wasm": { wasm: wasm.buffer },
        });
      }
      const inventory = [
        {
          name: "nested/main.js",
          type: "js",
          bytes: source.byteLength,
          sha256: NodeCrypto.createHash("sha256").update(source).digest("hex"),
        },
        {
          name: "nested/engine.wasm",
          type: "wasm",
          bytes: wasm.byteLength,
          sha256: NodeCrypto.createHash("sha256").update(wasm).digest("hex"),
        },
      ];
      const evidence: unknown = JSON.parse(await NodeFSP.readFile(output, "utf8"));
      expect(evidence).toMatchObject({
        schemaVersion: 1,
        rows: [
          {
            fixture: "fixture",
            cold: true,
            path: "/first",
            inventory,
            response: { status: 200, result: { ok: true } },
          },
          {
            fixture: "fixture",
            cold: false,
            path: "/fails",
            inventory,
            response: { status: 503, error: "fixture temporarily unavailable" },
          },
          {
            fixture: "fixture",
            cold: false,
            path: "/last",
            inventory,
            response: { status: 200, result: { ok: true } },
          },
        ],
        verificationErrors: expect.arrayContaining(["/fails: HTTP 503"]),
      });
      expect(JSON.parse(result.stdout)).toEqual(evidence);
    } finally {
      try {
        if (server.listening)
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
      } finally {
        await NodeFSP.rm(dir, { recursive: true, force: true });
      }
    }
  });

  it("sends request bodies as raw bytes and records request metadata and failures", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "isolate-requests-"));
    const received: Array<{ input: unknown; payload?: Uint8Array }> = [];
    const failures: unknown[] = [];
    const server = NodeHttp.createServer(async (request, response) => {
      try {
        expect(request.headers.authorization).toBe("Bearer fixture-test");
        expect(request.headers["content-type"]).toBe(MODULE_TRANSPORT_CONTENT_TYPE);
        const chunks: Uint8Array[] = [];
        for await (const chunk of request) {
          if (!(chunk instanceof Uint8Array)) throw new Error("Unexpected HTTP chunk");
          chunks.push(chunk);
        }
        const frame = Buffer.concat(chunks);
        const stream = () =>
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(frame);
              controller.close();
            },
          });
        const decoded = await decodeModuleTransport(stream());
        const payload = await openModuleTransport(stream()).then((transport) =>
          transport.readPayload(),
        );
        received.push({ input: decoded.input, ...(payload ? { payload } : {}) });
        if ((decoded.input as { path?: unknown }).path === "/fails") {
          response.writeHead(503);
          response.end("fixture temporarily unavailable");
        } else {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ status: 200, result: { ok: true } }));
        }
      } catch (error) {
        failures.push(error);
        response.writeHead(500);
        response.end("test failed");
      }
    });
    try {
      const payload = new Uint8Array([0, 255, 128, 10, 13, 0, 65]);
      await NodeFSP.mkdir(NodePath.join(dir, "nested"));
      await NodeFSP.writeFile(NodePath.join(dir, "nested", "body.bin"), payload);
      await NodeFSP.writeFile(
        NodePath.join(dir, "manifest.json"),
        JSON.stringify({
          id: "upload-fixture",
          mainModule: "main.js",
          entrypoint: "ProbeFacet",
          modules: {},
          requests: [
            {
              path: "/upload",
              method: "POST",
              contentType: "application/octet-stream",
              bodyFile: "nested/body.bin",
            },
            { path: "/fails" },
          ],
        }),
      );
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing HTTP port");
      const output = NodePath.join(dir, "evidence.json");
      const result = await new Promise<{
        code: string | number | undefined;
        stdout: string;
        stderr: string;
      }>((resolve) => {
        NodeChildProcess.execFile(
          process.execPath,
          [
            NodePath.join(import.meta.dirname, "measure.ts"),
            "--url",
            `http://127.0.0.1:${address.port}`,
            "--fixture",
            dir,
            "--output",
            output,
          ],
          { env: { ...process.env, PROBE_SECRET: "fixture-test" }, timeout: 45000 },
          (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }),
        );
      });
      expect(failures).toEqual([]);
      expect(result.code, result.stderr).toBe(1);
      expect(received).toHaveLength(2);
      expect(received[0]?.input).toMatchObject({
        id: expect.stringMatching(/^[a-f0-9]+-upload-fixture$/),
        path: "/upload",
        method: "POST",
        contentType: "application/octet-stream",
      });
      expect(received[0]?.payload).toEqual(payload);
      expect(received[1]?.input).toMatchObject({ path: "/fails" });
      expect(received[1]?.input).not.toHaveProperty("method");
      const evidence: unknown = JSON.parse(await NodeFSP.readFile(output, "utf8"));
      expect(evidence).toMatchObject({
        schemaVersion: 1,
        rows: [
          {
            fixture: "upload-fixture",
            cold: true,
            path: "/upload",
            request: {
              path: "/upload",
              method: "POST",
              contentType: "application/octet-stream",
              payload: {
                bytes: payload.byteLength,
                sha256: NodeCrypto.createHash("sha256").update(payload).digest("hex"),
                bodyFile: "nested/body.bin",
              },
            },
            inventory: [],
            response: { status: 200, result: { ok: true } },
          },
          {
            fixture: "upload-fixture",
            cold: false,
            path: "/fails",
            request: { path: "/fails", method: "GET" },
            inventory: [],
            response: { status: 503, error: "fixture temporarily unavailable" },
          },
        ],
        verificationErrors: expect.arrayContaining(["/fails: HTTP 503"]),
      });
      expect(JSON.parse(result.stdout)).toEqual(evidence);
    } finally {
      try {
        if (server.listening)
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
      } finally {
        await NodeFSP.rm(dir, { recursive: true, force: true });
      }
    }
  });

  it("rejects manifests that define both paths and requests", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "isolate-bad-manifest-"));
    try {
      await NodeFSP.writeFile(
        NodePath.join(dir, "manifest.json"),
        JSON.stringify({
          id: "ambiguous-fixture",
          mainModule: "main.js",
          entrypoint: "ProbeFacet",
          modules: {},
          paths: ["/legacy"],
          requests: [{ path: "/request" }],
        }),
      );
      const output = NodePath.join(dir, "evidence.json");
      const result = await new Promise<{
        code: string | number | undefined;
        stdout: string;
        stderr: string;
      }>((resolve) => {
        NodeChildProcess.execFile(
          process.execPath,
          [
            NodePath.join(import.meta.dirname, "measure.ts"),
            "--url",
            "http://127.0.0.1:1",
            "--fixture",
            dir,
            "--output",
            output,
          ],
          { env: { ...process.env, PROBE_SECRET: "fixture-test" }, timeout: 45000 },
          (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }),
        );
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("exactly one of paths or requests");
      await expect(NodeFSP.stat(output)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  });
});
