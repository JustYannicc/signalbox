import { expect, it } from "vite-plus/test";
import { ownedClaudeFacetWorker } from "./ownedClaudeFacets.ts";

function fixture(failAbort = false, failClass = false) {
  const events: string[] = [];
  const callbacks = new Map<
    string,
    () => WorkerLoaderWorkerCode | Promise<WorkerLoaderWorkerCode>
  >();
  const loader = {
    get(name: string, callback: () => WorkerLoaderWorkerCode | Promise<WorkerLoaderWorkerCode>) {
      callbacks.set(name, callback);
      return {
        getEntrypoint() {
          return {};
        },
        getDurableObjectClass() {
          if (failClass) throw new Error("class construction failed");
          return {
            [Symbol.dispose]() {
              events.push(`class:${name}`);
            },
          };
        },
        [Symbol.dispose]() {
          events.push(`worker:${name}`);
        },
      };
    },
  } as unknown as WorkerLoader;
  const ctx = {
    facets: {
      get(key: string) {
        events.push(`open:${key}`);
        return {
          [Symbol.dispose]() {
            events.push(`stub:${key}`);
          },
        };
      },
      abort(key: string) {
        events.push(`abort:${key}`);
        if (failAbort) throw new Error("abort failed");
      },
      delete(key: string) {
        events.push(`delete:${key}`);
      },
    },
  } as unknown as DurableObjectState;
  const code = { compatibilityDate: "2026-10-19", mainModule: "fixture.mjs", modules: {} };
  return { ctx, loader, events, callbacks, code };
}

it("retires both sibling owners exactly once with their host handle", async () => {
  const f = fixture();
  const host = ownedClaudeFacetWorker(f.ctx, f.loader, "host", async (owners) => {
    owners.kernel(() => f.code);
    owners.computer(() => f.code);
    return f.code;
  });
  await f.callbacks.get("host")!();
  expect(f.events).toEqual(["open:host:kernel", "open:host:computer"]);
  host[Symbol.dispose]();
  expect(f.events.slice(2)).toEqual([
    "abort:host:computer",
    "delete:host:computer",
    "stub:host:computer",
    "class:host:computer",
    "worker:host:computer",
    "abort:host:kernel",
    "delete:host:kernel",
    "stub:host:kernel",
    "class:host:kernel",
    "worker:host:kernel",
    "worker:host",
  ]);
  host[Symbol.dispose]();
  expect(f.events).toHaveLength(13);
});

it("still deletes facets and releases every stub when abort fails", async () => {
  const f = fixture(true);
  const host = ownedClaudeFacetWorker(f.ctx, f.loader, "host", async (owners) => {
    owners.kernel(() => f.code);
    owners.computer(() => f.code);
    return f.code;
  });
  await f.callbacks.get("host")!();
  expect(() => host[Symbol.dispose]()).toThrow(AggregateError);
  expect(f.events).toContain("delete:host:kernel");
  expect(f.events).toContain("delete:host:computer");
  expect(f.events).toContain("worker:host:kernel");
  expect(f.events).toContain("worker:host:computer");
  expect(f.events.at(-1)).toBe("worker:host");
});

it("releases a worker whose class cannot be constructed", async () => {
  const f = fixture(false, true);
  const host = ownedClaudeFacetWorker(f.ctx, f.loader, "host", async (owners) => {
    owners.kernel(() => f.code);
    return f.code;
  });
  await expect(f.callbacks.get("host")!()).rejects.toThrow("class construction failed");
  expect(f.events).toEqual(["worker:host:kernel"]);
  host[Symbol.dispose]();
  expect(f.events).toEqual(["worker:host:kernel", "worker:host"]);
});

it("rejects a late sibling construction after its host was retired", async () => {
  const f = fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const host = ownedClaudeFacetWorker(f.ctx, f.loader, "host", async (owners) => {
    entered.resolve();
    await release.promise;
    owners.kernel(() => f.code);
    return f.code;
  });
  const preparing = f.callbacks.get("host")!();
  await entered.promise;
  host[Symbol.dispose]();
  release.resolve();
  await expect(preparing).rejects.toThrow("construction was retired");
  expect(f.events).toEqual(["worker:host"]);
});
