import { DurableObject, WorkerEntrypoint, exports as hostExports } from "cloudflare:workers";
import { nativeTimingRecord, nativeTimingRow } from "./ModelProofTimingProjection.mjs";

const TRACE_ID = /^[a-f0-9]{16}$/;
const TABLE = "model_proof_native_timing";
const MAXIMUM_MINIMUM = 1000;
const MAXIMUM_ROWS = 1000;

export { nativeTimingRecord };

export class NativeTiming extends WorkerEntrypoint {
  async tail(traces) {
    const rows = traces.map((trace) => nativeTimingRecord(trace, this.ctx.props));
    await this.env.TIMINGS.get(this.env.TIMINGS.idFromName("model-proof-native-timings")).record(
      rows,
    );
  }
}

export class NativeTimingStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${TABLE} (id INTEGER PRIMARY KEY, trace_id TEXT NOT NULL, data TEXT NOT NULL)`,
    );
    ctx.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS model_proof_native_timing_run ON ${TABLE}(trace_id, id)`,
    );
    this.waiters = new Map();
  }

  record(rows) {
    if (!Array.isArray(rows)) throw new TypeError("timing rows must be an array");
    const safeRows = rows.map(nativeTimingRow);
    this.ctx.storage.transactionSync(() => {
      for (const row of safeRows) {
        this.ctx.storage.sql.exec(
          `INSERT INTO ${TABLE} (trace_id, data) VALUES (?, ?)`,
          row.traceId,
          JSON.stringify(row),
        );
      }
    });
    for (const traceId of new Set(safeRows.map((row) => row.traceId))) {
      for (const wake of this.waiters.get(traceId) ?? []) wake();
    }
  }

  snapshot(traceId) {
    return this.ctx.storage.sql
      .exec(
        `SELECT data FROM ${TABLE} WHERE trace_id = ? ORDER BY id LIMIT ?`,
        traceId,
        MAXIMUM_ROWS,
      )
      .toArray()
      .map((row) => JSON.parse(row.data));
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== "/model-proof-records") {
      return new Response("Not found", { status: 404 });
    }
    const traceId = url.searchParams.get("traceId") ?? "";
    const minimum = Number(url.searchParams.get("minimum") ?? "1");
    if (
      !TRACE_ID.test(traceId) ||
      !Number.isInteger(minimum) ||
      minimum < 0 ||
      minimum > MAXIMUM_MINIMUM
    ) {
      return new Response("Invalid timing query", { status: 400 });
    }

    let rows = this.snapshot(traceId);
    if (rows.length < minimum) {
      rows = await new Promise((resolve) => {
        const waiters = this.waiters.get(traceId) ?? new Set();
        let settled = false;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          waiters.delete(wake);
          if (waiters.size === 0) this.waiters.delete(traceId);
          request.signal.removeEventListener("abort", abort);
          resolve(value);
        };
        const wake = () => {
          const current = this.snapshot(traceId);
          if (current.length >= minimum) finish(current);
        };
        const abort = () => finish(null);
        waiters.add(wake);
        this.waiters.set(traceId, waiters);
        request.signal.addEventListener("abort", abort, { once: true });
        if (request.signal.aborted) abort();
        else wake();
      });
    }
    if (rows === null) return new Response("Aborted", { status: 499 });
    return Response.json({ traceId, rows });
  }
}

export function nativeTimingBinding(layer, traceId) {
  if (layer !== "facet" || !TRACE_ID.test(traceId ?? "")) {
    throw new TypeError("native timing requires a facet layer and 16-character lowercase trace ID");
  }
  return hostExports.NativeTiming({ props: { layer, traceId } });
}
