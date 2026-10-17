import { test } from "vitest";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { LunoraClient } from "lunorash/client";
import { Effect, Stream } from "effect";
import { api } from "./lunora/_generated/api.js";
import { CatalogSync } from "./src/CatalogSync.js";
import { lunoraLayer } from "./src/adapters/lunora.js";
const url = process.env.SPIKE_URL ?? "http://localhost:8847";
const idleMs = Number(process.env.SPIKE_IDLE_MS ?? 1000);
const count = Number(process.env.SPIKE_TABS ?? 8);
const sockets: WebSocket[] = [];
const network = {
  sentFrames: 0,
  sentBytes: 0,
  receivedFrames: 0,
  receivedBytes: 0,
  kinds: {} as Record<string, number>,
};
class MeteredSocket extends WebSocket {
  constructor(address: string) {
    super(address);
    sockets.push(this);
    this.on("message", (data) => {
      network.receivedFrames++;
      network.receivedBytes += Buffer.byteLength(data.toString());
      try {
        const kind = JSON.parse(data.toString()).type;
        network.kinds[kind] = (network.kinds[kind] ?? 0) + 1;
      } catch {}
    });
  }
  send(data: WebSocket.Data, ...args: unknown[]) {
    network.sentFrames++;
    network.sentBytes += Buffer.byteLength(data.toString());
    return super.send(data, ...args);
  }
}
const options = {
  url,
  WebSocket: MeteredSocket as unknown as typeof globalThis.WebSocket,
  crossTabSync: false,
  reconnect: { initialDelayMs: 4000, maxDelayMs: 4000, jitter: false },
};
function deferred<T>() {
  let resolve!: (x: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function deadline<T>(p: Promise<T>, label: string, ms = 30000) {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms);
      t.unref();
    }),
  ]);
}
type Rows = Awaited<ReturnType<LunoraClient["query"]>>;
function observer(client: LunoraClient, folder = "a") {
  let rows: any[] = [];
  let callbacks = 0;
  let rowDuplicates = 0;
  let regressions = 0;
  let prior = new Map<string, number>();
  const listeners = new Set<() => void>();
  const off = client.subscribe(
    api.catalog.threads,
    { folder },
    (next) => {
      callbacks++;
      rows = next;
      rowDuplicates += next.length - new Set(next.map((r) => r.key)).size;
      for (const row of next) {
        if (row.revision < (prior.get(row.key) ?? 0)) regressions++;
        prior.set(row.key, row.revision);
      }
      for (const f of listeners) f();
    },
    {
      onError: (error) => {
        for (const f of listeners) f();
        console.error("subscription error", error);
      },
    },
  );
  return {
    off,
    get rows() {
      return rows;
    },
    get callbacks() {
      return callbacks;
    },
    get rowDuplicates() {
      return rowDuplicates;
    },
    get regressions() {
      return regressions;
    },
    wait(predicate: (rows: any[]) => boolean, label: string) {
      if (predicate(rows)) return Promise.resolve();
      const d = deferred<void>();
      const f = () => {
        if (predicate(rows)) {
          listeners.delete(f);
          d.resolve();
        }
      };
      listeners.add(f);
      return deadline(d.promise, label);
    },
  };
}
async function diagnostic() {
  const r = await fetch(`${url}/spike/diagnostics`);
  assert.equal(r.status, 200);
  return r.json();
}
const percentile = (values: number[], q: number) =>
  [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(q * values.length))];
test("isolated catalog live-query measurements", async () => {
  const all: LunoraClient[] = [];
  const result: Record<string, unknown> = {
    url,
    timestamp: new Date().toISOString(),
    tabs: count,
    idleMs,
  };
  const writer = new LunoraClient(options);
  all.push(writer);
  try {
    const coldStart = performance.now();
    await writer.query(api.catalog.sidebar, {});
    result.coldEmptyQueryMs = performance.now() - coldStart;
    const seedStart = performance.now();
    await writer.mutation(api.catalog.seed, { count: 50 });
    result.warmSeedMs = performance.now() - seedStart;
    const clients = Array.from({ length: count }, () => new LunoraClient(options));
    all.push(...clients);
    const observers = clients.map((c) => observer(c));
    const sidebarCallbacks = clients.map(() => 0);
    const sidebarOff = clients.map((c, i) =>
      c.subscribe(api.catalog.sidebar, {}, () => sidebarCallbacks[i]++),
    );
    const control = new LunoraClient(options);
    all.push(control);
    const other = observer(control, "b");
    await Promise.all(
      [...observers, other].map((o, i) =>
        o.wait((rows) => rows.length === 25, `initial snapshot ${i}`),
      ),
    );
    const before = await diagnostic();
    const initialSidebar = [...sidebarCallbacks];
    const initialOtherCallbacks = other.callbacks;
    const latency: number[] = [];
    let missed = 0;
    for (let revision = 1; revision <= 20; revision++) {
      const start = performance.now();
      await writer.mutation(api.catalog.update, { key: "t0", revision });
      await Promise.all(
        observers.map((o, i) =>
          o.wait(
            (rows) => rows.some((r) => r.key === "t0" && r.revision === revision),
            `revision ${revision} tab ${i}`,
          ),
        ),
      );
      latency.push(performance.now() - start);
    }
    const after = await diagnostic();
    result.serial = {
      writes: 20,
      expectedDeliveries: 20 * count,
      observedCallbacks: observers.reduce((s, o) => s + o.callbacks - 1, 0),
      missed,
      rowDuplicates: observers.reduce((s, o) => s + o.rowDuplicates, 0),
      regressions: observers.reduce((s, o) => s + o.regressions, 0),
      p50Ms: percentile(latency, 0.5),
      p95Ms: percentile(latency, 0.95),
      maxMs: Math.max(...latency),
      sql: after.sql,
      executionsBefore: before.executions,
      executionsAfter: after.executions,
      sidebarCallbackDelta: sidebarCallbacks.map((v, i) => v - initialSidebar[i]),
      otherFolderCallbackDelta: other.callbacks - initialOtherCallbacks,
    };
    assert.equal(
      after.executions["threads:b"],
      before.executions["threads:b"],
      "unrelated folder should not rerun",
    );
    assert.equal(after.executions.sidebar, before.executions.sidebar, "sidebar should not rerun");
    // Move OUT of and back INTO a watched range. Both views must change membership.
    await writer.mutation(api.catalog.update, { key: "t0", revision: 21, folder: "b" });
    await Promise.all([
      observers[0].wait((rows) => !rows.some((r) => r.key === "t0"), "move out"),
      other.wait((rows) => rows.some((r) => r.key === "t0" && r.revision === 21), "move in"),
    ]);
    await writer.mutation(api.catalog.update, { key: "t0", revision: 22, folder: "a" });
    await Promise.all([
      observers[0].wait(
        (rows) => rows.some((r) => r.key === "t0" && r.revision === 22),
        "move back in",
      ),
      other.wait((rows) => !rows.some((r) => r.key === "t0"), "move back out"),
    ]);
    result.rangeMove = true;
    // Drop a transport without closing its client. Queue writes during the backoff window.
    const reconnectClient = new LunoraClient(options);
    all.push(reconnectClient);
    const reconnectView = observer(reconnectClient);
    await reconnectView.wait(
      (rows) => rows.some((r) => r.key === "t0" && r.revision === 22),
      "reconnect initial",
    );
    const previousSocket = sockets.at(-1)!;
    previousSocket.terminate();
    for (let revision = 23; revision <= 27; revision++)
      await writer.mutation(api.catalog.update, { key: "t0", revision });
    await reconnectView.wait(
      (rows) => rows.some((r) => r.key === "t0" && r.revision === 27),
      "catch up after reconnect",
    );
    result.reconnect = {
      offlineWrites: 5,
      finalRevision: 27,
      callbacks: reconnectView.callbacks,
      rowDuplicates: reconnectView.rowDuplicates,
      regressions: reconnectView.regressions,
    };
    // Replay the same logical revision to exercise app idempotency, not claim transport exactly-once.
    await writer.mutation(api.catalog.update, { key: "t0", revision: 27 });
    const idleBefore = await diagnostic();
    const networkBefore = { ...network };
    // Deliberate idle interval is the experimental input for hibernation, not a correctness wait.
    await delay(idleMs);
    const idleAfter = await diagnostic();
    result.idle = {
      bootBefore: idleBefore.bootId,
      bootAfter: idleAfter.bootId,
      hibernated: idleBefore.bootId !== idleAfter.bootId,
      sql: idleAfter.sql,
      sentFrames: network.sentFrames - networkBefore.sentFrames,
      receivedFrames: network.receivedFrames - networkBefore.receivedFrames,
    };
    const wakeStart = performance.now();
    await writer.mutation(api.catalog.update, { key: "t0", revision: 28 });
    await Promise.all(
      [...observers, reconnectView].map((o, i) =>
        o.wait(
          (rows) => rows.some((r) => r.key === "t0" && r.revision === 28),
          `post-idle tab ${i}`,
        ),
      ),
    );
    result.postIdle = {
      revision: 28,
      allClientsCurrent: true,
      latencyMs: performance.now() - wakeStart,
    };
    // The public Effect service supplies both snapshots and typed writes.
    const effectValue = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* CatalogSync;
          const rows = yield* Stream.runCollect(Stream.take(service.threads("a"), 1));
          const revision = yield* service.update("t0", 29);
          return { snapshotRows: rows[0].length, revision };
        }).pipe(Effect.provide(lunoraLayer(options))),
      ),
    );
    result.effect = effectValue;
    assert.equal(effectValue.revision, 29);
    assert(observers.every((o) => o.rowDuplicates === 0 && o.regressions === 0));
    result.network = network;
    result.socketCount = sockets.length;
    result.success = true;
    await writeFile("results.json", JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    sidebarOff.forEach((off) => off());
    observers.forEach((o) => o.off());
    other.off();
    reconnectView.off();
  } catch (error) {
    result.error = String(error);
    result.network = network;
    await writeFile("results.json", JSON.stringify(result, null, 2));
    throw error;
  } finally {
    all.forEach((c) => c.close());
    for (const socket of sockets) socket.terminate();
  }
}, 240000);
