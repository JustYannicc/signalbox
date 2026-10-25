import { JSPI_WASM_METADATA } from "./wasmFixture.ts";

// A separate source lets the ordinary DO use the same checks with its own storage context.
export const PROBE_SOURCE = String.raw`
import suspendModule from "./suspend.wasm";

const MIB = 1024 * 1024;
const MAX_MIB = 1024;
const retained = [];

function errorInfo(error) {
  return { name: error?.name ?? "Error", message: String(error?.message ?? error) };
}

async function observe(operation) {
  try {
    return { available: true, value: await operation() };
  } catch (error) {
    return { available: false, error: errorInfo(error) };
  }
}

async function statistics(operation) {
  const result = await observe(operation);
  if (!result.available) return result;
  const numbers = Object.values(result.value ?? {}).filter((value) => typeof value === "number");
  if (numbers.length === 0 || numbers.every((value) => value === 0)) {
    return { available: false, raw: result.value,
      error: { name: "Unavailable", message: numbers.length === 0 ? "No numeric statistics returned" : "Runtime returned an all-zero telemetry stub" } };
  }
  return result;
}

async function telemetry() {
  const [memoryUsage, heapStatistics] = await Promise.all([
    statistics(async () => {
      const process = await import("node:process");
      return process.memoryUsage();
    }),
    statistics(async () => {
      const v8 = await import("node:v8");
      return v8.getHeapStatistics();
    }),
  ]);
  return { memoryUsage, heapStatistics, retainedBytes: retained.length * MIB };
}

function functionProbe() {
  const nativeFunction = globalThis.Function;
  const result = { ok: false, nativeAttempts: 0, nativeFailures: 0, fallbackCalls: 0 };
  function nativeFirst(...args) {
    result.nativeAttempts++;
    try {
      return Reflect.apply(nativeFunction, this, args);
    } catch (error) {
      result.nativeFailures++;
      result.nativeError = errorInfo(error);
      // Only this known fixture is interpreted; arbitrary source must keep failing.
      if (args.length !== 3 || args[0] !== "a" || args[1] !== "b" || args[2] !== "return a + b") {
        throw error;
      }
      result.fallbackCalls++;
      return (a, b) => a + b;
    }
  }
  try {
    globalThis.Function = nativeFirst;
    result.value = globalThis.Function("a", "b", "return a + b")(20, 22);
    result.ok = result.value === 42;
  } catch (error) {
    result.error = errorInfo(error);
  } finally {
    if (globalThis.Function !== nativeFunction) globalThis.Function = nativeFunction;
  }
  result.restored = globalThis.Function === nativeFunction;
  return result;
}

async function requireProbe() {
  const observation = await observe(async () => {
    const { createRequire } = await import("node:module");
    // Dynamic Worker modules omit import.meta.url and resolve against logical module names.
    const require = createRequire("file:///main.js");
    const { answer } = require("./esm.js");
    if (answer !== 42) throw new Error("ESM require returned an unexpected answer");
    return { answer };
  });
  return { ok: observation.available, ...observation };
}

function wasmProbe() {
  try {
    const instance = new WebAssembly.Instance(suspendModule, {
      env: { suspend: (value) => value + 1 },
    });
    const value = instance.exports.run(${JSPI_WASM_METADATA.input});
    return { ok: value === ${JSPI_WASM_METADATA.expected}, value, expected: ${JSPI_WASM_METADATA.expected}, staticModule: true };
  } catch (error) {
    return { ok: false, error: errorInfo(error), staticModule: true };
  }
}

async function jspiProbe() {
  if (typeof WebAssembly.Suspending !== "function" || typeof WebAssembly.promising !== "function") {
    return { ok: false, available: false, error: { name: "Unavailable", message: "WebAssembly.Suspending/promising unavailable" } };
  }
  const events = [];
  try {
    let digestBytes;
    const instance = new WebAssembly.Instance(suspendModule, {
      env: {
        suspend: new WebAssembly.Suspending(async (value) => {
          events.push("import-enter");
          const digest = await crypto.subtle.digest("SHA-256", new Uint8Array([value]));
          digestBytes = digest.byteLength;
          if (digestBytes !== 32) throw new Error("Unexpected SHA-256 digest length");
          events.push("digest-resolved");
          return value + 1;
        }),
      },
    });
    const pending = WebAssembly.promising(instance.exports.run)(${JSPI_WASM_METADATA.input});
    const suspended = events.length === 1 && events[0] === "import-enter";
    const value = await pending;
    events.push("wasm-return");
    return { ok: suspended && value === ${JSPI_WASM_METADATA.expected} && digestBytes === 32, available: true,
      value, expected: ${JSPI_WASM_METADATA.expected}, suspended, digestBytes, events };
  } catch (error) {
    return { ok: false, available: true, error: errorInfo(error), events };
  }
}

function targetMiB(url) {
  const values = url.searchParams.getAll("mib");
  if (values.length !== 1 || !/^[0-9]+$/.test(values[0])) {
    throw new RangeError("mib must be one integer from 0 through " + MAX_MIB);
  }
  const value = Number(values[0]);
  if (!Number.isSafeInteger(value) || value > MAX_MIB) {
    throw new RangeError("mib must be one integer from 0 through " + MAX_MIB);
  }
  return value;
}

function allocate(mib) {
  // Target size, rather than an increment, bounds repeated requests and allows release with zero.
  if (retained.length > mib) retained.length = mib;
  while (retained.length < mib) {
    const buffer = new ArrayBuffer(MIB);
    new Uint8Array(buffer).fill(0xa5);
    retained.push(buffer);
  }
  return { ok: true, requestedMiB: mib, retainedBytes: retained.length * MIB, chunks: retained.length };
}

async function sqlite(mib, ctx) {
  const sql = ctx.storage.sql;
  sql.exec("CREATE TABLE IF NOT EXISTS probe_blobs (id INTEGER PRIMARY KEY, data BLOB NOT NULL)");
  sql.exec("DELETE FROM probe_blobs WHERE id > ?", mib);
  const existing = sql.exec("SELECT COUNT(*) AS count FROM probe_blobs").one().count;
  // SQLite makes each blob; JavaScript never holds the payload or reads rows back.
  for (let id = existing + 1; id <= mib; id++) {
    sql.exec("INSERT INTO probe_blobs (id, data) VALUES (?, zeroblob(?))", id, MIB);
  }
  const summary = sql.exec("SELECT COUNT(*) AS rows, COALESCE(SUM(length(data)), 0) AS bytes FROM probe_blobs").one();
  // Authorization of diagnostics is independent of whether the blob writes succeeded.
  const [pageCount, pageSize, databaseSize] = await Promise.all([
    observe(() => sql.exec("PRAGMA page_count").one().page_count),
    observe(() => sql.exec("PRAGMA page_size").one().page_size),
    observe(() => {
      const value = sql.databaseSize;
      if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("storage.sql.databaseSize unavailable");
      return value;
    }),
  ]);
  const pageBytes = pageCount.available && pageSize.available
    ? { available: true, value: pageCount.value * pageSize.value }
    : { available: false, error: { name: "Unavailable", message: "PRAGMA page_count/page_size unavailable" } };
  return { ok: summary.bytes === mib * MIB, requestedMiB: mib, payloadBytes: summary.bytes,
    rows: summary.rows, pageCount, pageSize, pageBytes, databaseSize };
}

export async function probe(request, ctx) {
  const url = new URL(request.url);
  try {
    switch (url.pathname) {
      case "/status":
        return Response.json(await telemetry());
      case "/capabilities":
        return Response.json({ requireEsm: await requireProbe(), functionConstructor: functionProbe(),
          wasm: wasmProbe(), jspi: await jspiProbe() });
      case "/wasm":
        return Response.json(wasmProbe());
      case "/jspi":
        return Response.json(await jspiProbe());
      case "/allocate":
        return Response.json(allocate(targetMiB(url)));
      case "/sqlite":
        return Response.json(await sqlite(targetMiB(url), ctx));
      default:
        return Response.json({ ok: false, error: { name: "NotFound", message: "Unknown probe path" } }, { status: 404 });
    }
  } catch (error) {
    return Response.json({ ok: false, error: errorInfo(error) }, { status: error instanceof RangeError ? 400 : 500 });
  }
}
`;

export const FACET_SOURCE = String.raw`
import { DurableObject } from "cloudflare:workers";
${PROBE_SOURCE}
export class ProbeFacet extends DurableObject {
  fetch(request) {
    return probe(request, this.ctx);
  }
}
`;
