// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - exercise native Worker Loader network permissions through the standalone host.
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import { createTestHarness } from "wrangler";
import { prepare } from "./prepare.ts";
import {
  encodeModuleTransport,
  MODULE_TRANSPORT_CONTENT_TYPE,
  type ModuleDescriptor,
} from "./moduleTransport.ts";
import { JSPI_WASM } from "./wasmFixture.ts";

let harness: ReturnType<typeof createTestHarness> | undefined;
let endpoint: string;
let outboundUrl: string;
let outboundRequests = 0;
const server = NodeHttp.createServer((_request, response) => {
  outboundRequests++;
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ answer: 42 }));
});

beforeAll(async () => {
  await prepare();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("Missing test port");
  outboundUrl = `http://127.0.0.1:${address.port}/fixture`;
  harness = createTestHarness({
    workers: [{ configPath: NodePath.join(import.meta.dirname, "wrangler.jsonc") }],
  });
  endpoint = (await harness.listen()).url.toString();
}, 15000);

afterAll(async () => {
  try {
    await harness?.close();
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }
});

const run = async (id: string, allowOutbound?: unknown) => {
  const response = await fetch(new URL(`/run?session=${id}`, endpoint), {
    method: "POST",
    headers: { authorization: "Bearer local-probe-only", "content-type": "application/json" },
    body: JSON.stringify({
      id,
      allowOutbound,
      modules: {
        "main.js": {
          js: `import {DurableObject} from "cloudflare:workers";
          export class ProbeFacet extends DurableObject {
            async fetch() {
              try {
                const response = await fetch(${JSON.stringify(outboundUrl)});
                return Response.json({allowed:true,value:await response.json()});
              } catch { return Response.json({allowed:false}); }
            }
          }`,
        },
      },
    }),
  });
  return response.json();
};

describe("isolate fixture outbound access", () => {
  it("blocks network unless a fixture explicitly supplies true", async () => {
    for (const [index, value] of [undefined, false, "true"].entries()) {
      const result = await run(`outbound-denied-${index}`, value);
      expect(result).toMatchObject({ status: 200, result: { allowed: false } });
    }
    expect(outboundRequests).toBe(0);
    const result = await run("outbound-allowed", true);
    expect(result).toMatchObject({ status: 200, result: { allowed: true, value: { answer: 42 } } });
    expect(outboundRequests).toBe(1);
  });
});

const framedRun = async (
  input: unknown,
  modules: readonly ModuleDescriptor[] = [],
  body = encodeModuleTransport(input, modules),
) => {
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    headers: {
      authorization: "Bearer local-probe-only",
      "content-type": MODULE_TRANSPORT_CONTENT_TYPE,
    },
    body,
    duplex: "half",
  };
  return fetch(new URL("/run?session=framed-fixture", endpoint), init);
};

describe("framed fixtures over workerd HTTP", () => {
  it("validates every warm upload even when native WorkerLoader skips its source callback", async () => {
    const input = { id: "framed-warm-validation", mode: "worker" };
    const source = (text: string): ModuleDescriptor[] => [
      { name: "main.js", type: "js", bytes: new TextEncoder().encode(text) },
    ];
    const modules = source("export default {fetch(){return Response.json({value:42})}}");
    expect(await (await framedRun(input, modules)).json()).toMatchObject({
      status: 200,
      result: { value: 42 },
    });
    // A warm native worker ignores replacement source, but its upload still has to be well framed.
    expect(
      await (await framedRun(input, source("this is not valid JavaScript!"))).json(),
    ).toMatchObject({ status: 200, result: { value: 42 } });
    const invalidUtf8 = await framedRun(input, [
      { name: "main.js", type: "js", bytes: new Uint8Array([255]) },
    ]);
    const invalidBody = await invalidUtf8.text();
    expect(invalidUtf8.status, invalidBody).toBe(400);
    const packet = new Uint8Array(
      await new Response(encodeModuleTransport(input, modules)).arrayBuffer(),
    );
    for (const [bytes, error] of [
      [packet.subarray(0, -1), "Truncated module main.js"],
      [new Uint8Array([...packet, 0]), "Trailing module transport bytes"],
    ] as const) {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
      const response = await framedRun(input, [], body);
      const result = await response.text();
      expect(response.status, result).toBe(400);
      expect(result).toContain(error);
    }
    expect(await (await framedRun(input, modules)).json()).toMatchObject({
      status: 200,
      result: { value: 42 },
    });
  });

  it("rejects malformed cold uploads and boots a fresh worker from a full map", async () => {
    const input = { id: "framed-cold-validation", mode: "worker" };
    const response = await framedRun(input, [
      { name: "main.js", type: "js", bytes: new Uint8Array([255]) },
    ]);
    const body = await response.text();
    expect(response.status, body).toBe(400);
    const valid = await framedRun({ ...input, id: "framed-fresh-validation" }, [
      {
        name: "main.js",
        type: "js",
        bytes: new TextEncoder().encode(
          "export default {fetch(){return Response.json({cold:true})}}",
        ),
      },
    ]);
    expect(await valid.json()).toMatchObject({ status: 200, result: { cold: true } });
  });

  it("keeps legacy baseline, generated-code, concurrency and base64 module requests working", async () => {
    const send = async (id: string, input: object) => {
      const response = await fetch(new URL(`/run?session=${id}`, endpoint), {
        method: "POST",
        headers: { authorization: "Bearer local-probe-only", "content-type": "application/json" },
        body: JSON.stringify({ id, ...input }),
      });
      expect(response.status).toBe(200);
      return response.json();
    };
    expect(await send("legacy-baseline", { path: "/wasm" })).toMatchObject({
      status: 200,
      result: { ok: true, value: 42 },
    });
    expect(await send("legacy-generated", { mode: "worker", generatedValue: 37 })).toMatchObject({
      status: 200,
      result: { value: 37, generated: true },
    });
    expect(await send("legacy-concurrent", { count: 2 })).toMatchObject({
      count: 2,
      results: [
        { ok: true, value: { ok: true } },
        { ok: true, value: { ok: true } },
      ],
    });
    expect(
      await send("legacy-base64", {
        mode: "worker",
        modules: {
          "main.js": `import wasm from "./engine.wasm";
        const instance = new WebAssembly.Instance(wasm,{env:{suspend:value=>value+1}});
        export default {fetch(){return Response.json({value:instance.exports.run(40)})}};`,
          "engine.wasm": { wasmBase64: btoa(String.fromCharCode(...JSPI_WASM)) },
        },
      }),
    ).toMatchObject({ status: 200, result: { value: 42 } });
  });

  it("keeps outbound access denied unless framed input supplies exactly true", async () => {
    const modules: ModuleDescriptor[] = [
      {
        name: "main.js",
        type: "js",
        bytes: new TextEncoder().encode(`export default {
        async fetch() {
          try {
            const response = await fetch(${JSON.stringify(outboundUrl)});
            return Response.json({allowed:true,value:await response.json()});
          } catch { return Response.json({allowed:false}); }
        }
      }`),
      },
    ];
    const before = outboundRequests;
    for (const [index, allowOutbound] of [undefined, false, "true", true].entries()) {
      const response = await framedRun(
        { id: `framed-outbound-${index}`, mode: "worker", allowOutbound },
        modules,
      );
      expect(await response.json()).toMatchObject({
        status: 200,
        result: { allowed: allowOutbound === true },
      });
      expect(outboundRequests).toBe(before + (allowOutbound === true ? 1 : 0));
    }
  });

  it("loads mixed module types and keeps one facet's SQLite state across full-map uploads", async () => {
    const source = `import {DurableObject} from "cloudflare:workers";
      import wasm from "./engine.wasm";
      import {input} from "./esm.js";
      import common from "./common.cjs";
      import text from "./greeting.txt";
      const instance = new WebAssembly.Instance(wasm, {env:{suspend:value=>value+common}});
      const result = () => ({value:instance.exports.run(input),text});
      export default {fetch(){return Response.json(result())}};
      export class ProbeFacet extends DurableObject {
        fetch(request) {
          const sql = this.ctx.storage.sql;
          sql.exec("CREATE TABLE IF NOT EXISTS counter (id INTEGER PRIMARY KEY, value INTEGER)");
          sql.exec("INSERT OR IGNORE INTO counter VALUES (1, 0)");
          if (new URL(request.url).pathname === "/increment") sql.exec("UPDATE counter SET value = value + 1 WHERE id = 1");
          const count = sql.exec("SELECT value FROM counter WHERE id = 1").one().value;
          return Response.json({...result(),count});
        }
      }`;
    const utf8 = (value: string) => new TextEncoder().encode(value);
    const modules: ModuleDescriptor[] = [
      { name: "nested/main.js", type: "js", bytes: utf8(source) },
      { name: "nested/esm.js", type: "js", bytes: utf8("export const input = 40;") },
      { name: "nested/common.cjs", type: "cjs", bytes: utf8("module.exports = 1;") },
      { name: "nested/greeting.txt", type: "text", bytes: utf8("\uFEFFGrüezi 🌍\r\n") },
      { name: "nested/engine.wasm", type: "wasm", bytes: JSPI_WASM },
    ];
    for (const [path, count] of [
      ["/increment", 1],
      ["/increment", 2],
      ["/read", 2],
    ] as const) {
      const response = await framedRun(
        { id: "framed-facet", mainModule: "nested/main.js", path },
        modules,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        status: 200,
        result: { value: 42, text: "\uFEFFGrüezi 🌍\r\n", count },
      });
    }
    const response = await framedRun(
      {
        id: "framed-worker",
        mainModule: "nested/main.js",
        mode: "worker",
      },
      modules,
    );
    expect(await response.json()).toMatchObject({
      status: 200,
      result: { value: 42, text: "\uFEFFGrüezi 🌍\r\n" },
    });
  });

  it("validates opaque input before passing it to WorkerLoader", async () => {
    for (const input of [
      null,
      [],
      {},
      { id: 7 },
      { id: "bad/id" },
      { id: "valid", mode: "other" },
      { id: "valid", mainModule: 4 },
      { id: "valid", entrypoint: [] },
      { id: "valid", path: false },
      { id: "valid", count: "2" },
      { id: "valid", generatedValue: {} },
    ]) {
      const response = await framedRun(input);
      const body = await response.text();
      expect(response.status, body).toBe(400);
      expect(body).toBe("Invalid probe input");
    }
  });

  it("returns an HTTP error for a truncated frame", async () => {
    const response = await fetch(new URL("/run?session=truncated", endpoint), {
      method: "POST",
      headers: {
        authorization: "Bearer local-probe-only",
        "content-type": MODULE_TRANSPORT_CONTENT_TYPE,
      },
      body: new Uint8Array([0, 0]),
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Truncated metadata length");
  });
});
