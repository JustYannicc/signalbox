// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - exercise native Worker Loader network permissions through the standalone host.
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "@effect/vitest";
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

afterEach(({ task }) => {
  if (task.result?.state === "fail") harness?.debug();
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
  outerHeaders: Record<string, string> = {},
) => {
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    headers: {
      authorization: "Bearer local-probe-only",
      "content-type": MODULE_TRANSPORT_CONTENT_TYPE,
      ...outerHeaders,
    },
    body,
    duplex: "half",
  };
  const response = await fetch(new URL("/run?session=framed-fixture", endpoint), init);
  if (response.status >= 500)
    throw new Error(`${JSON.stringify(input)}: HTTP ${response.status}: ${await response.text()}`);
  return response;
};

describe("framed fixtures over workerd HTTP", () => {
  it("returns a metadata budget rejection through the forwarded HTTP hop", async () => {
    const response = await fetch(new URL("/run?session=metadata-budget", endpoint), {
      method: "POST",
      headers: {
        authorization: "Bearer local-probe-only",
        "content-type": MODULE_TRANSPORT_CONTENT_TYPE,
      },
      body: new Uint8Array([255, 255, 255, 255, 7]),
    });
    const error = await response.text();
    expect(response.status, error).toBe(400);
    expect(error).toContain("Metadata budget exceeded");
  });

  it("cannot use a legacy worker's export to bypass framed upload validation", async () => {
    const id = "legacy-preflight-collision";
    const before = outboundRequests;
    const response = await fetch(new URL("/run?session=framed-fixture", endpoint), {
      method: "POST",
      headers: { authorization: "Bearer local-probe-only", "content-type": "application/json" },
      body: JSON.stringify({
        id,
        mode: "worker",
        entrypoint: "SignalboxTransportPreflight",
        allowOutbound: true,
        modules: {
          "main.js": `import { WorkerEntrypoint } from "cloudflare:workers";
          export class SignalboxTransportPreflight extends WorkerEntrypoint {
            async fetch(){await fetch(${JSON.stringify(outboundUrl)});return Response.json({legacy:true})}
          }`,
        },
      }),
    });
    expect(await response.json()).toMatchObject({ status: 200, result: { legacy: true } });
    expect(outboundRequests).toBe(before + 1);
    const malformed = await framedRun({ id, mode: "worker" }, [
      { name: "main.js", type: "js", bytes: new Uint8Array([255]) },
    ]);
    expect(malformed.status, await malformed.text()).toBe(400);
    expect(outboundRequests).toBe(before + 1);
  });

  it("rejects a changed cached entrypoint without invoking the original fixture", async () => {
    const modules: ModuleDescriptor[] = [
      {
        name: "main.js",
        type: "js",
        bytes: new TextEncoder().encode(`
      import { WorkerEntrypoint } from "cloudflare:workers";
      export class SignalboxTransportPreflight extends WorkerEntrypoint {
        async fetch(){await fetch(${JSON.stringify(outboundUrl)});return Response.json({fixture:true})}
      }`),
      },
    ];
    const input = {
      id: "changed-entrypoint",
      mode: "worker",
      entrypoint: "SignalboxTransportPreflight",
      allowOutbound: true,
    };
    const before = outboundRequests;
    expect(await (await framedRun(input, modules)).json()).toMatchObject({
      status: 200,
      result: { fixture: true },
    });
    expect(outboundRequests).toBe(before + 1);
    const rejected = await framedRun({ ...input, entrypoint: "default" }, [
      { name: "main.js", type: "js", bytes: new Uint8Array([255]) },
    ]);
    expect(rejected.status, await rejected.text()).toBe(400);
    expect(outboundRequests).toBe(before + 1);
    const changed = await framedRun({ ...input, entrypoint: "default" }, modules);
    expect(await changed.json()).toMatchObject({
      error: expect.any(String),
    });
    expect(outboundRequests).toBe(before + 1);
  });

  const configurations: { name: string; mode: "worker" | "facet"; entrypoint?: string }[] = [
    { name: "worker-default", mode: "worker" },
    { name: "worker-named", mode: "worker", entrypoint: "NamedWorker" },
    { name: "worker-quoted", mode: "worker", entrypoint: 'a "quoted" export' },
    { name: "worker-collision", mode: "worker", entrypoint: "SignalboxTransportPreflight" },
    { name: "facet-default", mode: "facet" },
    { name: "facet-collision", mode: "facet", entrypoint: "SignalboxTransportPreflight" },
  ];
  for (const config of configurations) {
    it.each(["UTF8", "truncated", "trailing", "trailing-chunk"])(
      `${config.name} rejects %s before any new fixture effects`,
      async (failure) => {
        const entrypoint = config.entrypoint ?? "ProbeFacet";
        const source = `import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
        import {marker} from "../__signalbox_probe_preflight__.js";
        let calls = 0;
        async function touch(request, sql) {
          if (sql) {
            sql.exec("CREATE TABLE IF NOT EXISTS counter (value INTEGER)");
            sql.exec("INSERT INTO counter SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM counter)");
          }
          if (new URL(request.url).pathname === "/bump") {
            if (sql) sql.exec("UPDATE counter SET value = value + 1");
            else calls++;
            await fetch(${JSON.stringify(outboundUrl)});
          }
          return Response.json({calls:sql ? sql.exec("SELECT value FROM counter").one().value : calls,marker});
        }
        export default {fetch(request){return touch(request)}};
        class FixtureEntrypoint extends ${config.mode === "worker" ? "WorkerEntrypoint" : "DurableObject"} {
          fetch(request){return touch(request,${config.mode === "worker" ? "undefined" : "this.ctx.storage.sql"})}
        }
        export { FixtureEntrypoint as ${JSON.stringify(entrypoint)} };`;
        const modules: ModuleDescriptor[] = [
          { name: "nested/main.js", type: "js", bytes: new TextEncoder().encode(source) },
          {
            name: "__signalbox_probe_preflight__.js",
            type: "js",
            bytes: new TextEncoder().encode("export const marker = 'original';"),
          },
        ];
        const input = {
          id: `effects-${config.name}-${failure}`,
          mode: config.mode,
          ...(config.entrypoint ? { entrypoint: config.entrypoint } : {}),
          mainModule: "nested/main.js",
          allowOutbound: true,
          path: "/bump",
        };
        const before = outboundRequests;
        expect(await (await framedRun(input, modules)).json()).toMatchObject({
          status: 200,
          result: { calls: 1, marker: "original" },
        });
        expect(outboundRequests).toBe(before + 1);
        const packet = new Uint8Array(
          await new Response(encodeModuleTransport(input, modules)).arrayBuffer(),
        );
        let body: ReadableStream<Uint8Array>;
        if (failure === "UTF8") {
          body = encodeModuleTransport(input, [
            { ...modules[0]!, bytes: new Uint8Array([255]) },
            modules[1]!,
          ]);
        } else {
          const chunks =
            failure === "truncated"
              ? [packet.subarray(0, -1)]
              : failure === "trailing"
                ? [new Uint8Array([...packet, 0])]
                : [packet, new Uint8Array([0])];
          let index = 0;
          body = new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                const chunk = chunks[index++];
                if (chunk) controller.enqueue(chunk);
                else controller.close();
              },
            },
            { highWaterMark: 0 },
          );
        }
        const response = await framedRun(input, [], body);
        const error = await response.text();
        expect(response.status, `${failure}: ${error}`).toBe(400);
        expect(error).toMatch(
          failure === "UTF8"
            ? /decode|UTF/i
            : failure === "truncated"
              ? /Truncated module/
              : /Trailing module transport bytes/,
        );
        expect(outboundRequests).toBe(before + 1);
        expect(await (await framedRun({ ...input, path: "/read" }, modules)).json()).toMatchObject({
          status: 200,
          result: { calls: 1, marker: "original" },
        });
        expect(outboundRequests).toBe(before + 1);
        expect(await (await framedRun(input, modules)).json()).toMatchObject({
          status: 200,
          result: { calls: 2 },
        });
        expect(outboundRequests).toBe(before + 2);
      },
    );
  }

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

  it("passes opaque POST bytes to the facet and keeps them in that facet's SQLite state", async () => {
    const source = `import { DurableObject } from "cloudflare:workers";
      import wasm from "./engine.wasm";
      const wasmValue = () => new WebAssembly.Instance(wasm, {env:{suspend:value=>value+1}}).exports.run(40);
      const requestInfo = request => ({
        method: request.method,
        contentType: request.headers.get("content-type"),
        authorization: request.headers.get("authorization"),
        origin: request.headers.get("origin"),
        probeSecret: request.headers.get("x-probe-secret"),
        forwardedFor: request.headers.get("x-forwarded-for")
      });
      export default { async fetch(request) {
        return Response.json({...requestInfo(request), wasm:wasmValue(), body:[...new Uint8Array(await request.arrayBuffer())]});
      }};
      export class ProbeFacet extends DurableObject {
        async fetch(request) {
          const sql = this.ctx.storage.sql;
          const body = [...new Uint8Array(await request.arrayBuffer())];
          sql.exec("CREATE TABLE IF NOT EXISTS seeded_asset (id TEXT PRIMARY KEY, bytes BLOB NOT NULL, content_type TEXT)");
          const info = requestInfo(request);
          if (new URL(request.url).pathname === "/seed-assets") {
            sql.exec("INSERT OR REPLACE INTO seeded_asset(id, bytes, content_type) VALUES (?, ?, ?)",
              "boot", new Uint8Array(body).buffer, info.contentType);
          }
          const asset = sql.exec("SELECT bytes, content_type FROM seeded_asset WHERE id = ?", "boot").one();
          return Response.json({...info, wasm:wasmValue(), body,
            stored:[...new Uint8Array(asset.bytes)], storedContentType:asset.content_type});
        }
      }`;
    const modules: ModuleDescriptor[] = [
      { name: "main.js", type: "js", bytes: new TextEncoder().encode(source) },
      { name: "engine.wasm", type: "wasm", bytes: JSPI_WASM },
    ];
    const binaryA = new Uint8Array([0xff, 0xc3, 0x28, 0x00, 0x80, 0xfe]);
    const binaryB = new Uint8Array([0x00, 0x9f, 0xff, 0x41, 0x80]);
    const id = "native-payload-facet";
    const post = (bytes: Uint8Array) => {
      const input = {
        id,
        method: "POST",
        contentType: "application/octet-stream",
        path: "/seed-assets",
      };
      return framedRun(input, modules, encodeModuleTransport(input, modules, {}, bytes), {
        origin: "https://attacker.invalid",
        "x-probe-secret": "outer-only",
        "x-forwarded-for": "203.0.113.9",
      });
    };
    const first = await post(binaryA);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      status: 200,
      result: {
        method: "POST",
        contentType: "application/octet-stream",
        authorization: null,
        origin: null,
        probeSecret: null,
        forwardedFor: null,
        wasm: 42,
        body: [...binaryA],
        stored: [...binaryA],
        storedContentType: "application/octet-stream",
      },
    });

    const read = async () => {
      const input = { id, path: "/boot" };
      return framedRun(input, modules);
    };
    expect(await (await read()).json()).toMatchObject({
      status: 200,
      result: {
        method: "GET",
        contentType: null,
        authorization: null,
        origin: null,
        probeSecret: null,
        forwardedFor: null,
        wasm: 42,
        body: [],
        stored: [...binaryA],
        storedContentType: "application/octet-stream",
      },
    });

    const reseeded = await post(binaryB);
    expect(reseeded.status).toBe(200);
    expect(await reseeded.json()).toMatchObject({
      status: 200,
      result: { body: [...binaryB], stored: [...binaryB], wasm: 42 },
    });
    expect(await (await read()).json()).toMatchObject({
      status: 200,
      result: { body: [], stored: [...binaryB], wasm: 42 },
    });

    const workerInput = {
      id: "native-payload-worker",
      mode: "worker",
      path: "/seed-assets",
      method: "POST",
      contentType: "application/octet-stream",
    };
    expect(
      await (
        await framedRun(
          workerInput,
          modules,
          encodeModuleTransport(workerInput, modules, {}, binaryA),
        )
      ).json(),
    ).toMatchObject({
      status: 200,
      target: "worker",
      result: {
        method: "POST",
        body: [...binaryA],
        contentType: "application/octet-stream",
        wasm: 42,
        authorization: null,
        origin: null,
      },
    });
  });

  it.each(["truncated", "trailing"] as const)(
    "rejects a %s payload on cold and warm facets before SQL or outbound effects",
    async (failure) => {
      const modules: ModuleDescriptor[] = [
        {
          name: "main.js",
          type: "js",
          bytes: new TextEncoder().encode(`import { DurableObject } from "cloudflare:workers";
            export class ProbeFacet extends DurableObject {
              async fetch(request) {
                const sql = this.ctx.storage.sql;
                sql.exec("CREATE TABLE IF NOT EXISTS counter (value INTEGER)");
                sql.exec("INSERT INTO counter SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM counter)");
                if (new URL(request.url).pathname === "/bump") {
                  sql.exec("UPDATE counter SET value = value + 1");
                  await fetch(${JSON.stringify(outboundUrl)});
                }
                return Response.json({calls:sql.exec("SELECT value FROM counter").one().value});
              }
            }`),
        },
      ];
      const opaque = new Uint8Array([0xff, 0x80, 0x00, 0xc3, 0x28]);
      const malformedBody = (input: unknown) => encodeModuleTransport(input, modules, {}, opaque);
      const damaged = async (input: unknown) => {
        const packet = new Uint8Array(await new Response(malformedBody(input)).arrayBuffer());
        const bytes =
          failure === "truncated" ? packet.subarray(0, -1) : new Uint8Array([...packet, 0]);
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        });
      };
      const base = {
        method: "POST",
        contentType: "application/octet-stream",
        path: "/bump",
        allowOutbound: true,
      };

      for (const warmed of [false, true]) {
        const id = `payload-${warmed ? "warm" : "cold"}-${failure}`;
        const initial = { ...base, id };
        const before = outboundRequests;
        if (warmed) {
          const response = await framedRun(
            initial,
            modules,
            encodeModuleTransport(initial, modules, {}, new Uint8Array([0x01])),
          );
          expect(await response.json()).toMatchObject({ status: 200, result: { calls: 1 } });
          expect(outboundRequests).toBe(before + 1);
        }

        const rejected = await framedRun(initial, modules, await damaged(initial));
        const error = await rejected.text();
        expect(rejected.status, error).toBe(400);
        expect(error).toContain(
          failure === "truncated" ? "Truncated request payload" : "Trailing module transport bytes",
        );
        expect(outboundRequests).toBe(before + (warmed ? 1 : 0));

        const readInput = { id, path: "/read", allowOutbound: true };
        expect(await (await framedRun(readInput, modules)).json()).toMatchObject({
          status: 200,
          result: { calls: warmed ? 1 : 0 },
        });
        expect(outboundRequests).toBe(before + (warmed ? 1 : 0));
        if (!warmed) {
          const valid = await framedRun(
            initial,
            modules,
            encodeModuleTransport(initial, modules, {}, opaque),
          );
          expect(await valid.json()).toMatchObject({ status: 200, result: { calls: 1 } });
          expect(outboundRequests).toBe(before + 1);
        }
      }
    },
  );

  it("still rejects invalid UTF-8 code when a separate opaque request payload is present", async () => {
    const input = {
      id: "payload-invalid-code",
      method: "POST",
      contentType: "application/octet-stream",
      path: "/bump",
      allowOutbound: true,
    };
    const before = outboundRequests;
    const response = await framedRun(
      input,
      [{ name: "main.js", type: "js", bytes: new Uint8Array([0xff]) }],
      encodeModuleTransport(
        input,
        [{ name: "main.js", type: "js", bytes: new Uint8Array([0xff]) }],
        {},
        new Uint8Array([0xff, 0x00, 0x80]),
      ),
    );
    const error = await response.text();
    expect(response.status, error).toBe(400);
    expect(error).toMatch(/decode|UTF/i);
    expect(outboundRequests).toBe(before);
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
      { id: "valid", method: "POST\r\nInjected" },
      { id: "valid", method: "TRACE" },
      { id: "valid", method: 3 },
      { id: "valid", contentType: "application/octet-stream\r\nInjected: yes" },
      { id: "valid", contentType: [] },
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
