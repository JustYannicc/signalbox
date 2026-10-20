// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - exercise replay and cleanup against real Durable Object SQLite and WorkerLoader callbacks.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import { createTestHarness } from "wrangler";
import { prepare } from "./prepare.ts";
import { encodeModuleTransport, type ModuleDescriptor } from "./moduleTransport.ts";
import { JSPI_WASM } from "./wasmFixture.ts";

let harness: ReturnType<typeof createTestHarness> | undefined;
let directory: string | undefined;
let endpoint: string;

beforeAll(async () => {
  await prepare();
  directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "probe-module-upload-"));
  for (const name of ["moduleUpload", "moduleTransport"]) {
    await NodeFSP.copyFile(
      new URL(`./generated/${name}.js`, import.meta.url),
      NodePath.join(directory, `${name}.js`),
    );
  }
  await NodeFSP.writeFile(
    NodePath.join(directory, "worker.js"),
    `
import { DurableObject } from "cloudflare:workers";
import { ModuleUploadStore } from "./moduleUpload.js";
import { encodeModuleTransport } from "./moduleTransport.js";
function payloadSummary(bytes) {
  if (bytes === undefined) return null;
  const indexes = [0, 1, 65534, 65535, 65536, 65537, 70000];
  let checksum = 2166136261;
  for (const byte of bytes) checksum = Math.imul(checksum ^ byte, 16777619) >>> 0;
  return {byteLength:bytes.byteLength,
    sample:indexes.filter(index => index < bytes.byteLength).map(index => bytes[index]), checksum};
}
export class UploadTest extends DurableObject {
  store = new ModuleUploadStore(this.ctx.storage.sql);
  rows() { return this.ctx.storage.sql.exec("SELECT count(*) AS rows, max(length(data)) AS maxChunk FROM probe_module_upload").one(); }
  async fetch(request) {
    let upload;
    let callbacks = 0;
    const codeInventories = [];
    try {
      if (new URL(request.url).pathname === "/recovery") {
        let cancellations = 0;
        const failure = new Error("staging source failed");
        const broken = new ReadableStream({
          start(controller) { controller.error(failure); },
          cancel() { cancellations++; }
        });
        let original;
        try { await this.store.stage(broken); } catch(error) { original = error === failure; }
        const failedRows = this.rows().rows;
        const packet = new Uint8Array(await new Response(encodeModuleTransport({}, [])).arrayBuffer());
        let offset = 0;
        upload = await this.store.stage(new ReadableStream({pull(controller) {
          if (offset < packet.length) controller.enqueue(packet.slice(offset, ++offset));
          else controller.close();
        }}));
        const fragmentedRows = this.rows().rows;
        upload.dispose();
        this.ctx.storage.sql.exec("INSERT INTO probe_module_upload VALUES (99, zeroblob(3))");
        this.store = new ModuleUploadStore(this.ctx.storage.sql);
        return Response.json({original, cancellations, unlocked:!broken.locked, failedRows, fragmentedRows, remaining:this.rows().rows});
      }
      upload = await this.store.stage(request.body);
      const {id, operation} = upload.input;
      let result;
      const staged = this.rows();
      if (operation === "lifecycle") {
        let overlapping;
        try { await this.store.stage(encodeModuleTransport({}, [])); }
        catch(error) { overlapping = String(error); }
        upload.dispose();
        upload.dispose();
        const next = await this.store.stage(encodeModuleTransport({}, []));
        let released;
        try { await upload.readModules(); } catch(error) { released = String(error); }
        await next.readModules();
        next.dispose();
        result = {overlapping, released};
      } else if (operation === "payload-disposed") {
        const bytes = upload.readPayload();
        upload.dispose();
        let released;
        try { upload.readPayload(); } catch(error) { released = String(error); }
        result = {payload:payloadSummary(bytes), released};
      } else if (operation === "mutate") {
        const first = await upload.readModules();
        first["main.js"].js = "changed";
        new Uint8Array(first["suspend.wasm"].wasm).fill(255);
        const second = await upload.readModules();
        result = {source:second["main.js"].js, wasm:[...new Uint8Array(second["suspend.wasm"].wasm)]};
      } else if (operation === "throw") {
        await upload.readModules();
        throw new Error("original callback failure");
      } else {
        const getCode = async () => {
          callbacks++;
          const modules = await upload.readModules();
          codeInventories.push(Object.keys(modules));
          const code = { compatibilityDate:"2026-10-18", mainModule:"main.js",
            modules, globalOutbound:null };
          return code;
        };
        if (operation === "payload") {
          const bytes = upload.readPayload();
          const payload = payloadSummary(bytes);
          const worker = this.env.LOADER.get("payload-entry:" + id, getCode);
          const entry = await (await worker.getEntrypoint().fetch("https://probe.invalid/")).json();
          const facetWorker = this.env.LOADER.get("payload-facet:" + id, getCode);
          const facet = this.ctx.facets.get(id, () => ({class:facetWorker.getDurableObjectClass("ProbeFacet")}));
          const facetResult = await (await facet.fetch("https://probe.invalid/")).json();
          result = {entry, payload:payload ?? null, hasPayload:upload.hasPayload,
            facet:facetResult, codeInventories};
          upload.dispose();
          return Response.json({result, callbacks, staged, remaining:this.rows().rows});
        }
        const worker = this.env.LOADER.get("entry:" + id, getCode);
        const entry = await (await worker.getEntrypoint().fetch("https://probe.invalid/")).json();
        // Local workerd can reuse one code callback across both lookups. Distinct cold keys force
        // the separate callback observed for entrypoint then facet in the deployed runtime.
        const facetWorker = this.env.LOADER.get("facet:" + id, getCode);
        const facet = this.ctx.facets.get(id, () => ({class:facetWorker.getDurableObjectClass("ProbeFacet")}));
        result = {entry, facet:await (await facet.fetch("https://probe.invalid/")).json()};
      }
      upload.dispose();
      return Response.json({result, callbacks, staged, remaining:this.rows().rows});
    } catch(error) {
      upload?.dispose();
      // As in the probe HTTP boundary, unread input must reach EOF before forwarding a rejection.
      const reader = request.body.getReader();
      try {
        while (!(await reader.read()).done) {}
      } finally {
        reader.releaseLock();
      }
      return Response.json({error:String(error), callbacks, remaining:this.rows().rows}, {status:400});
    }
  }
}
export default {fetch(request, env) {return env.TEST.get(env.TEST.idFromName("test")).fetch(request)}};
`,
  );
  const configPath = NodePath.join(directory, "wrangler.json");
  await NodeFSP.writeFile(
    configPath,
    JSON.stringify({
      name: "module-upload-test",
      main: "worker.js",
      no_bundle: true,
      find_additional_modules: true,
      rules: [{ type: "ESModule", globs: ["**/*.js"] }],
      compatibility_date: "2026-10-18",
      worker_loaders: [{ binding: "LOADER" }],
      durable_objects: { bindings: [{ name: "TEST", class_name: "UploadTest" }] },
      migrations: [{ tag: "v1", new_sqlite_classes: ["UploadTest"] }],
    }),
  );
  harness = createTestHarness({ workers: [{ configPath }] });
  endpoint = (await harness.listen()).url.toString();
}, 15000);

afterAll(async () => {
  try {
    await harness?.close();
  } finally {
    if (directory) await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

const source = `import {DurableObject} from "cloudflare:workers";
import wasm from "./suspend.wasm";
import text from "./padding.txt";
function value(){return {answer:new WebAssembly.Instance(wasm,{env:{suspend:n=>n+1}}).exports.run(40),length:text.length}}
export default {fetch(){return Response.json(value())}};
export class ProbeFacet extends DurableObject {
  fetch(){this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS calls(n INTEGER)");
    this.ctx.storage.sql.exec("INSERT INTO calls VALUES (1)");
    return Response.json({...value(),calls:this.ctx.storage.sql.exec("SELECT count(*) AS n FROM calls").one().n});}
}`;
const modules: ModuleDescriptor[] = [
  { name: "main.js", type: "js", bytes: new TextEncoder().encode(source) },
  { name: "suspend.wasm", type: "wasm", bytes: JSPI_WASM },
  { name: "padding.txt", type: "text", bytes: new TextEncoder().encode("ü".repeat(70000)) },
];

const send = async (
  id: string,
  operation = "execute",
  body = encodeModuleTransport({ id, operation }, modules),
) => {
  const init: RequestInit & { duplex: "half" } = { method: "POST", body, duplex: "half" };
  return fetch(endpoint, init);
};

describe("SQL-staged module uploads", () => {
  it("releases failed sources, coalesces tiny chunks, and removes interrupted staging on initialization", async () => {
    const response = await fetch(new URL("/recovery", endpoint));
    expect(await response.json()).toEqual({
      original: true,
      cancellations: 0,
      unlocked: true,
      failedRows: 0,
      fragmentedRows: 1,
      remaining: 0,
    });
  });

  it("replays complete mixed maps for separate entrypoint and facet callbacks, then discards a warm map", async () => {
    const id = "separate-callbacks";
    const first = await send(
      id,
      "execute",
      encodeModuleTransport(
        { id, operation: "execute" },
        modules,
        {},
        new Uint8Array([0xff, 0x00, 0x80]),
      ),
    );
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      callbacks: 2,
      remaining: 0,
      staged: { rows: 3, maxChunk: 65536 },
      result: {
        entry: { answer: 42, length: 70000 },
        facet: { answer: 42, length: 70000, calls: 1 },
      },
    });
    expect(
      await (
        await send(
          id,
          "execute",
          encodeModuleTransport({ id, operation: "execute" }, modules, {}, new Uint8Array(0)),
        )
      ).json(),
    ).toMatchObject({
      callbacks: 0,
      remaining: 0,
      result: { facet: { calls: 2 } },
    });
  });

  it("reads opaque payload ranges directly from SQLite without adding them to WorkerLoader code", async () => {
    const binary = Uint8Array.from(
      { length: 70001 },
      (_, index) => [0xff, 0x00, 0x80, 0xc3, 0x28][index % 5]!,
    );
    const payloadSummary = {
      byteLength: binary.byteLength,
      sample: [0, 1, 65534, 65535, 65536, 65537, 70000].map((index) => binary[index]),
      checksum: binary.reduce((hash, byte) => Math.imul(hash ^ byte, 16777619) >>> 0, 2166136261),
    };
    const id = "payload-range";
    const upload = (payload?: Uint8Array) =>
      send(
        id,
        "payload",
        encodeModuleTransport({ id, operation: "payload" }, modules, {}, payload),
      );

    const cold = await upload(binary);
    expect(cold.status).toBe(200);
    expect(await cold.json()).toMatchObject({
      callbacks: 2,
      remaining: 0,
      result: {
        entry: { answer: 42, length: 70000 },
        payload: payloadSummary,
        hasPayload: true,
        codeInventories: [
          ["main.js", "suspend.wasm", "padding.txt"],
          ["main.js", "suspend.wasm", "padding.txt"],
        ],
        facet: { answer: 42, length: 70000, calls: 1 },
      },
    });

    const warm = await upload(new Uint8Array(0));
    expect(warm.status).toBe(200);
    expect(await warm.json()).toMatchObject({
      callbacks: 0,
      remaining: 0,
      result: {
        entry: { answer: 42, length: 70000 },
        facet: { answer: 42, length: 70000, calls: 2 },
        payload: {
          byteLength: 0,
          sample: [],
          checksum: 2166136261,
        },
        hasPayload: true,
        codeInventories: [],
      },
    });

    const absentId = "payload-absent";
    const absent = await send(
      absentId,
      "payload",
      encodeModuleTransport({ id: absentId, operation: "payload" }, modules),
    );
    expect(await absent.json()).toMatchObject({
      callbacks: 2,
      remaining: 0,
      result: { payload: null, hasPayload: false, facet: { calls: 1 } },
    });
  });

  it("keeps direct payload reads behind the same disposal guard", async () => {
    const id = "payload-disposed";
    const response = await send(
      id,
      "payload-disposed",
      encodeModuleTransport(
        { id, operation: "payload-disposed" },
        [],
        {},
        new Uint8Array([0xff, 0x00, 0x80]),
      ),
    );
    expect(await response.json()).toMatchObject({
      result: {
        payload: {
          byteLength: 3,
          sample: [0xff, 0x00],
          checksum: [0xff, 0x00, 0x80].reduce(
            (hash, byte) => Math.imul(hash ^ byte, 16777619) >>> 0,
            2166136261,
          ),
        },
        released: "Error: Staged module upload has been released",
      },
      remaining: 0,
    });
  });

  it("does not retain materialized maps or mutable binary buffers between callbacks", async () => {
    expect(await (await send("mutate", "mutate")).json()).toMatchObject({
      remaining: 0,
      result: { source, wasm: [...JSPI_WASM] },
    });
  });

  it("deletes staging after a callback error and preserves the original error", async () => {
    expect(await (await send("throw", "throw")).json()).toMatchObject({
      remaining: 0,
      error: "Error: original callback failure",
    });
    expect((await send("after-throw")).status).toBe(200);
  });

  it("rejects overlapping staging and prevents a disposed reader from accessing the next upload", async () => {
    expect(await (await send("lifecycle", "lifecycle")).json()).toMatchObject({
      remaining: 0,
      result: {
        overlapping: "Error: Another framed upload is active for this session",
        released: "Error: Staged module upload has been released",
      },
    });
  });

  it.each(["UTF8", "truncated", "trailing"])(
    "rejects %s before any callback and removes partial SQL rows",
    async (failure) => {
      const frame = new Uint8Array(
        await new Response(encodeModuleTransport({ id: "malformed" }, modules)).arrayBuffer(),
      );
      const body =
        failure === "UTF8"
          ? encodeModuleTransport({ id: "malformed" }, [
              { name: "main.js", type: "js", bytes: new Uint8Array([255]) },
            ])
          : new Response(
              failure === "truncated" ? frame.subarray(0, -1) : new Uint8Array([...frame, 0]),
            ).body!;
      const response = await send("malformed", "execute", body);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ callbacks: 0, remaining: 0 });
      expect((await send(`after-${failure}`)).status).toBe(200);
    },
  );

  it.each(["truncated", "trailing"] as const)(
    "removes partial SQLite staging when a %s payload is rejected",
    async (failure) => {
      const id = `malformed-payload-${failure}`;
      const input = { id, operation: "payload" };
      const payload = new Uint8Array([0xff, 0x00, 0x80]);
      const frame = new Uint8Array(
        await new Response(encodeModuleTransport(input, modules, {}, payload)).arrayBuffer(),
      );
      const damaged =
        failure === "truncated" ? frame.subarray(0, -1) : new Uint8Array([...frame, 0]);
      const response = await send(id, "payload", new Response(damaged).body!);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ callbacks: 0, remaining: 0 });
      expect((await send(`after-payload-${failure}`)).status).toBe(200);
    },
  );
});
