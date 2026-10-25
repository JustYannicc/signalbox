// @effect-diagnostics nodeBuiltinImport:off - the raw-JavaScript fixture needs a child Node runtime with JSPI enabled.
import * as NodeChildProcess from "node:child_process";
import * as NodeProcess from "node:process";

import { describe, it } from "@effect/vitest";

import { FACET_SOURCE, PROBE_SOURCE } from "./facetSource.ts";
import { JSPI_WASM } from "./wasmFixture.ts";

// Keep V8's experimental JSPI flag inside a child, without changing the test runner's runtime.
const harness = String.raw`
import assert from "node:assert/strict";
import * as vm from "node:vm";
import * as fs from "node:fs";
import * as nodeCrypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
const { source, wasm, script, restrictedFunction, telemetryFailure, telemetryStub, pragmaFailure, withoutJspi, behaviorOnly } = JSON.parse(fs.readFileSync(0, "utf8"));
const allocations = [];
class TrackedBuffer extends ArrayBuffer {
  constructor(size) { super(size); allocations.push(this); }
}
const context = vm.createContext({ URL, Request, Response, Uint8Array, ArrayBuffer: TrackedBuffer,
  crypto: nodeCrypto.webcrypto, WebAssembly: withoutJspi ? { Instance: WebAssembly.Instance } : WebAssembly });
if (restrictedFunction) vm.runInContext('globalThis.Function = function () { throw new EvalError("code generation disabled"); }', context);
const originalFunction = vm.runInContext("globalThis.Function", context);
const db = new DatabaseSync(":memory:");
const sql = {
  exec(query, ...bindings) {
    if (pragmaFailure && query.startsWith("PRAGMA")) throw new Error("SQLITE_AUTH: not authorized");
    const statement = db.prepare(query);
    if (statement.columns().length === 0) { statement.run(...bindings); return; }
    const rows = statement.all(...bindings);
    return { one() { assert.equal(rows.length, 1); return rows[0]; } };
  },
  get databaseSize() { return db.prepare("PRAGMA page_count").get().page_count * db.prepare("PRAGMA page_size").get().page_size; },
};
const ctx = { storage: { sql } };
const requireCalls = [];
async function synthetic(values) {
  const module = new vm.SyntheticModule(Object.keys(values), function () {
    for (const [name, value] of Object.entries(values)) this.setExport(name, value);
  }, { context });
  await module.link(() => { throw new Error("Unexpected synthetic import"); });
  await module.evaluate();
  return module;
}
const module = new vm.SourceTextModule(source, {
  context, identifier: "file:///main.js",
  // Match dynamic Worker modules, whose import.meta.url is undefined.
  async importModuleDynamically(specifier) {
    if (specifier === "node:module") return synthetic({
      createRequire(base) {
        assert.equal(base, "file:///main.js");
        return (name) => {
          requireCalls.push(name);
          assert.equal(name, "./esm.js");
          assert.equal(new URL(name, base).pathname, "/esm.js");
          return { answer: 42 };
        };
      },
    });
    if (telemetryFailure) return synthetic(specifier === "node:process"
      ? { memoryUsage() { throw new Error("memory telemetry disabled"); } }
      : {});
    if (telemetryStub) return synthetic(specifier === "node:process"
      ? { memoryUsage() { return { rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }; } }
      : { getHeapStatistics() { return { total_heap_size: 0, used_heap_size: 0, heap_size_limit: 0 }; } });
    return synthetic(await import(specifier));
  },
});
await module.link(async (specifier) => {
  if (specifier === "./suspend.wasm") return synthetic({ default: new WebAssembly.Module(new Uint8Array(wasm)) });
  assert.equal(specifier, "cloudflare:workers");
  return synthetic({ DurableObject: class { constructor(ctx) { this.ctx = ctx; } } });
});
await module.evaluate();
const facet = behaviorOnly ? { fetch: (request) => module.namespace.probe(request, ctx) } : new module.namespace.ProbeFacet(ctx);
async function request(path) {
  const response = await facet.fetch(new Request("https://probe.invalid" + path));
  return { status: response.status, data: await response.json() };
}
try {
  await new Function("request", "assert", "context", "vm", "originalFunction", "allocations", "requireCalls", "sql", "ctx", "db", "module",
    "return (async () => {" + script + "})()")(
      request, assert, context, vm, originalFunction, allocations, requireCalls, sql, ctx, db, module);
} finally { db.close(); }
`;

function check(
  script: string,
  options: {
    restrictedFunction?: boolean;
    telemetryFailure?: boolean;
    telemetryStub?: boolean;
    pragmaFailure?: boolean;
    withoutJspi?: boolean;
    behaviorOnly?: boolean;
  } = {},
) {
  NodeChildProcess.execFileSync(
    NodeProcess.execPath,
    [
      "--experimental-wasm-jspi",
      "--experimental-vm-modules",
      "--input-type=module",
      "--eval",
      harness,
    ],
    {
      input: JSON.stringify({
        source: options.behaviorOnly ? PROBE_SOURCE : FACET_SOURCE,
        wasm: Array.from(JSPI_WASM),
        script,
        ...options,
      }),
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 15_000,
    },
  );
}

describe("isolate probe source", () => {
  it("loads the raw module and resumes WASM after an actual crypto await", () => {
    check(String.raw`
      const capabilities = await request("/capabilities");
      assert.equal(capabilities.status, 200);
      assert.deepEqual(capabilities.data.requireEsm, { ok: true, available: true, value: { answer: 42 } });
      assert.deepEqual(requireCalls, ["./esm.js"]);
      assert.deepEqual(capabilities.data.functionConstructor, {
        ok: true, nativeAttempts: 1, nativeFailures: 0, fallbackCalls: 0, value: 42, restored: true,
      });
      assert.equal(vm.runInContext("globalThis.Function", context), originalFunction);
      const wasm = await request("/wasm");
      assert.deepEqual(wasm.data, { ok: true, value: 42, expected: 42, staticModule: true });
      const jspi = await request("/jspi");
      assert.equal(jspi.data.ok, true);
      assert.equal(jspi.data.value, 42);
      assert.equal(jspi.data.suspended, true);
      assert.equal(jspi.data.digestBytes, 32);
      assert.deepEqual(jspi.data.events, ["import-enter", "digest-resolved", "wasm-return"]);
      assert.equal(capabilities.data.jspi.ok, true);
    `);
  });

  it("uses the bounded Function fallback and restores the original constructor", () => {
    check(
      String.raw`
        const { data } = await request("/capabilities");
        assert.equal(data.functionConstructor.ok, true);
        assert.equal(data.functionConstructor.nativeAttempts, 1);
        assert.equal(data.functionConstructor.nativeFailures, 1);
        assert.equal(data.functionConstructor.fallbackCalls, 1);
        assert.equal(data.functionConstructor.nativeError.message, "code generation disabled");
        assert.equal(vm.runInContext("globalThis.Function", context), originalFunction);
      `,
      { restrictedFunction: true },
    );
  });

  it("retains touched buffers at a bounded target and releases them at zero", () => {
    check(String.raw`
      assert.equal((await request("/allocate?mib=2")).data.retainedBytes, 2 * 1048576);
      assert.equal(allocations.length, 2);
      for (const buffer of allocations) {
        const bytes = new Uint8Array(buffer);
        assert.equal(bytes[0], 0xa5);
        assert.equal(bytes[4096], 0xa5);
        assert.equal(bytes[bytes.length - 1], 0xa5);
      }
      await request("/allocate?mib=2");
      assert.equal(allocations.length, 2);
      assert.equal((await request("/status")).data.retainedBytes, 2 * 1048576);
      assert.equal((await request("/allocate?mib=0")).data.retainedBytes, 0);
      assert.equal((await request("/status")).data.retainedBytes, 0);
    `);
  });

  it("writes SQLite blobs without materializing payloads and reports actual page measurements", () => {
    check(String.raw`
      const { data, status } = await request("/sqlite?mib=3");
      assert.equal(status, 200);
      assert.equal(data.ok, true);
      assert.equal(data.rows, 3);
      assert.equal(data.payloadBytes, 3 * 1048576);
      assert.ok(data.pageBytes.value >= data.payloadBytes);
      assert.equal(data.pageBytes.available, true);
      assert.equal(data.pageBytes.value, data.pageCount.value * data.pageSize.value);
      assert.deepEqual(data.databaseSize, { available: true, value: sql.databaseSize });
      assert.equal(allocations.length, 0);
      assert.equal((await request("/sqlite?mib=3")).data.rows, 3);
      assert.equal((await request("/sqlite?mib=1")).data.rows, 1);
      assert.equal((await request("/sqlite?mib=0")).data.payloadBytes, 0);
    `);
  });

  it("rejects invalid or over-limit targets before changing memory or SQLite", () => {
    check(String.raw`
      for (const path of ["/allocate", "/sqlite"]) {
        for (const suffix of ["", "?mib=-1", "?mib=1.5", "?mib=NaN", "?mib=Infinity", "?mib=1025", "?mib=9999999999999999999", "?mib=1&mib=2", "?mib="]) {
          assert.equal((await request(path + suffix)).status, 400);
        }
      }
      assert.equal(allocations.length, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'probe_blobs'").get().count, 0);
      assert.equal((await request("/unknown")).status, 404);
    `);
  });

  it("reports real Node telemetry through the shared ordinary-DO handler", () => {
    check(
      String.raw`
        const { data, status } = await request("/status");
        assert.equal(status, 200);
        assert.equal(data.memoryUsage.available, true);
        assert.ok(data.memoryUsage.value.rss > 0);
        assert.equal(data.heapStatistics.available, true);
        assert.ok(data.heapStatistics.value.heap_size_limit > 0);
        assert.equal((await request("/wasm")).data.ok, true);
      `,
      { behaviorOnly: true },
    );
  });

  it("marks all-zero runtime stubs unavailable and preserves their raw values", () => {
    check(
      String.raw`
        const { data, status } = await request("/status");
        assert.equal(status, 200);
        for (const metric of [data.memoryUsage, data.heapStatistics]) {
          assert.equal(metric.available, false);
          assert.match(metric.error.message, /all-zero telemetry stub/);
          assert.equal(Object.hasOwn(metric, "value"), false);
          assert.ok(Object.values(metric.raw).every(value => value === 0));
        }
      `,
      { telemetryStub: true },
    );
  });

  it("keeps successful SQLite writes and databaseSize when PRAGMA queries are forbidden", () => {
    check(
      String.raw`
        const { data, status } = await request("/sqlite?mib=2");
        assert.equal(status, 200);
        assert.equal(data.ok, true);
        assert.equal(data.rows, 2);
        assert.equal(data.payloadBytes, 2 * 1048576);
        assert.deepEqual(data.databaseSize, { available: true, value: sql.databaseSize });
        for (const metric of [data.pageCount, data.pageSize]) {
          assert.equal(metric.available, false);
          assert.match(metric.error.message, /SQLITE_AUTH/);
        }
        assert.equal(data.pageBytes.available, false);
      `,
      { pragmaFailure: true },
    );
  });

  it("preserves unavailable telemetry and JSPI errors without failing the response", () => {
    check(
      String.raw`
        const { data, status } = await request("/status");
        assert.equal(status, 200);
        assert.equal(data.memoryUsage.available, false);
        assert.equal(data.memoryUsage.error.message, "memory telemetry disabled");
        assert.equal(data.heapStatistics.available, false);
        assert.equal(data.heapStatistics.error.name, "TypeError");
        assert.equal(Object.hasOwn(data.memoryUsage, "value"), false);
        assert.equal(Object.hasOwn(data.heapStatistics, "value"), false);
        const jspi = await request("/jspi");
        assert.equal(jspi.status, 200);
        assert.equal(jspi.data.ok, false);
        assert.equal(jspi.data.available, false);
        assert.equal(jspi.data.error.name, "Unavailable");
        Object.defineProperty(sql, "databaseSize", { get() { throw new Error("SQL size disabled"); } });
        const sqlite = await request("/sqlite?mib=1");
        assert.equal(sqlite.data.ok, true);
        assert.equal(sqlite.data.databaseSize.available, false);
        assert.equal(sqlite.data.databaseSize.error.message, "SQL size disabled");
      `,
      { telemetryFailure: true, withoutJspi: true },
    );
  });
});
