import { describe, expect, it } from "vite-plus/test";
import { LocalTailCapture, type TailStorage } from "./LocalTailCapture.fixture.ts";
import { createLocalTailLog, type TailLogFile } from "./LocalTailLog.fixture.ts";

function file() {
  let text = "";
  let closed = false;
  const handle: TailLogFile = {
    async writeFile(value) {
      if (closed) throw new Error("File is closed");
      text += value;
    },
    async sync() {
      if (closed) throw new Error("File is closed");
    },
    async readFile() {
      return text;
    },
    async close() {
      closed = true;
    },
  };
  return handle;
}

function storage() {
  const rows = new Map<string, unknown>();
  const store: TailStorage = {
    async get<T>(key: string) {
      return rows.get(key) as T | undefined;
    },
    async put(key, value) {
      rows.set(key, value);
    },
    async transaction(body) {
      return await body(store);
    },
    async list<T>({ prefix, startAfter, end, limit }: Parameters<TailStorage["list"]>[0]) {
      return new Map(
        [...rows]
          .sort(([a], [b]) => a.localeCompare(b))
          .filter(
            ([key]) =>
              key.startsWith(prefix) && (!startAfter || key > startAfter) && (!end || key < end),
          )
          .slice(0, limit)
          .map(([key, value]) => [key, value as T]),
      );
    },
  };
  return { store, rows };
}
const batch = (id: string) => [
  {
    logs: [
      {
        message: [
          JSON.stringify({
            producerEvent: {
              schema: "sb1070/producer/v1",
              runId: "run",
              invocationId: id,
              milestone: "terminal",
            },
          }),
        ],
      },
    ],
  },
];

describe("incremental Tail capture", () => {
  it("captures every raw sequence once across drains, retries and final catch-up", async () => {
    const { store } = storage();
    const capture = new LocalTailCapture(store, "run");
    const handle = file();
    const log = await createLocalTailLog(handle, "run");
    try {
      await capture.append(batch("one"));
      const first = await capture.drain({ after: 0, ids: ["one"] });
      await log.append(first, ["one"]);
      await expect(log.append(first, ["one"])).rejects.toThrow("cursor");
      await capture.append(batch("two"));
      const second = await capture.drain({ after: log.cursor, ids: ["two"] });
      expect(second.records.map((row) => row.key)).toEqual(["raw/0000000002"]);
      await log.append(second, ["two"]);
      const retry = await capture.drain({ after: log.cursor, ids: ["one"] });
      expect(retry.records).toEqual([]);
      await log.append(retry, ["one"]);
      await capture.append([{ logs: [] }]);
      await log.append(await capture.drain({ after: log.cursor, ids: [] }), []);
      const snapshot = await log.snapshot();
      expect(snapshot.records.map((row) => row.raw)).toEqual([
        JSON.stringify(batch("one")),
        JSON.stringify(batch("two")),
        '[{"logs":[]}]',
      ]);
      expect(snapshot.terminals).toEqual(["one", "two"]);
      expect((await handle.readFile()).trim().split("\n")).toHaveLength(3);
    } finally {
      await log.close();
    }
  });

  it("does not lose an append between registering a waiter and reading its index", async () => {
    const { store } = storage();
    const capture = new LocalTailCapture(store, "run");
    const originalGet = store.get.bind(store);
    store.get = async <T>(key: string) => {
      if (key === "terminal/race") {
        await capture.append(batch("race"));
        return undefined;
      }
      return await originalGet<T>(key);
    };
    expect((await capture.drain({ after: 0, ids: ["race"] })).records).toHaveLength(1);
  });

  it("rejects gaps, altered terminal bytes and cursors ahead of storage", async () => {
    const { store, rows } = storage();
    const capture = new LocalTailCapture(store, "run");
    await expect(capture.drain({ after: 1, ids: [] })).rejects.toThrow("ahead");
    await capture.append(batch("one"));
    rows.set("raw/0000000001", "[]");
    await expect(capture.drain({ after: 0, ids: ["one"] })).rejects.toThrow("exact raw");
    rows.delete("raw/0000000001");
    await expect(capture.drain({ after: 0, ids: [] })).rejects.toThrow("incomplete");
  });

  it("paginates contiguous raw records past the storage list limit", async () => {
    const { store, rows } = storage();
    rows.set("sequence", 1001);
    for (let i = 1; i <= 1001; i++) rows.set(`raw/${String(i).padStart(10, "0")}`, "[]");
    const capture = new LocalTailCapture(store, "run");
    expect((await capture.drain({ after: 0, ids: [] })).records).toHaveLength(1001);
  });
  it("refuses concurrent writes, wrong-run terminals and writes after an I/O failure", async () => {
    const { store } = storage();
    const capture = new LocalTailCapture(store, "run");
    await capture.append(batch("one"));
    const first = await capture.drain({ after: 0, ids: ["one"] });
    const log = await createLocalTailLog(file(), "run");
    try {
      const wrongRun = {
        ...first,
        terminalEvidence: first.terminalEvidence.map((entry) => ({ ...entry, runId: "other" })),
      };
      await expect(log.append(wrongRun, ["one"])).rejects.toThrow("terminal");
      expect(log.cursor).toBe(0);
      const writing = log.append(first, ["one"]);
      await expect(log.append(first, ["one"])).rejects.toThrow("Concurrent");
      await writing;
      await capture.append(batch("two"));
      const second = await capture.drain({ after: log.cursor, ids: ["two"] });
      await log.close();
      await expect(log.append(second, ["two"])).rejects.toThrow();
      expect(log.cursor).toBe(1);
      await expect(log.append(second, ["two"])).rejects.toThrow("failed write");
    } finally {
      await log.close();
    }
  });

  it("keeps the cursor fixed until sync succeeds and stops after a sync failure", async () => {
    const { store } = storage();
    const capture = new LocalTailCapture(store, "run");
    await capture.append(batch("one"));
    const first = await capture.drain({ after: 0, ids: ["one"] });
    const handle = file();
    const entered = Promise.withResolvers<void>();
    const sync = Promise.withResolvers<void>();
    handle.sync = async () => {
      entered.resolve();
      await sync.promise;
    };
    const log = await createLocalTailLog(handle, "run");
    const append = log.append(first, ["one"]);
    const rejected = expect(append).rejects.toThrow("sync failed");
    await entered.promise;
    expect(log.cursor).toBe(0);
    await expect(log.snapshot()).rejects.toThrow("unavailable");
    sync.reject(new Error("sync failed"));
    await rejected;
    expect(log.cursor).toBe(0);
    await expect(log.append(first, ["one"])).rejects.toThrow("failed write");
    await log.close();
  });
});
