import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { FolderId } from "@t3tools/contracts/signalboxFolders";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as Ledger from "./PoolUsageLedger.ts";
import * as History from "./poolUsageHistory.ts";
import { makeMemoryPoolObject } from "./testing.ts";

const AT = Date.parse("2026-10-18T12:00:00Z");
const request = (requestId = "upstream-1"): Ledger.UsageRequest => ({
  source: "cliproxyapi",
  requestId,
  at: AT,
  attribution: {
    _tag: "thread",
    poolOwnerId: "pool-owner",
    poolId: "team-pool",
    userId: "requester",
    homeOwnerId: "organization",
    homeLevel: { _tag: "folder", folderId: FolderId.make("folder-game-night") },
    poolLevel: { _tag: "top" },
    threadId: "thread-1",
    runId: "run-1",
    visibility: "private",
  },
  provider: "anthropic",
  harness: "claudeAgent",
  accountId: "account-1",
  lenderId: "lender-1",
  requestedModel: "claude-opus-5-5",
  responseModel: "claude-opus-5-5",
  reasoningEffort: "high",
  serviceTier: "standard",
  stream: true,
  status: 200,
  outcome: "complete",
  latencyMs: 1234,
  ttftMs: 250,
  tokens: {
    uncachedInputTokens: 100,
    cachedInputTokens: 200,
    cacheCreationTokens: 50,
    outputTokens: 300,
    reasoningTokens: 100,
  },
  quotaAfter: { fiveHourUsedPercent: 60, weeklyUsedPercent: null },
  pricing: { version: "litellm:fixture-v1", costUsd: 0.023 },
});
const window = { since: AT - 1, until: AT + 1, limit: 100 };
const inMemory = <A, E, R>(effect: Effect.Effect<A, E, R | SqlClient.SqlClient>) =>
  Effect.gen(function* () {
    yield* Ledger.createTable;
    return yield* effect;
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })));

describe("pool usage ledger", () => {
  it.effect("keeps one immutable request across retries, scoped to its source", () =>
    inMemory(
      Effect.gen(function* () {
        expect(yield* Ledger.append(request())).toBe(true);
        expect(yield* Ledger.append({ ...request(), tokens: null, pricing: null })).toBe(false);
        expect(yield* Ledger.append({ ...request(), source: "other-upstream" })).toBe(true);
        const result = yield* Ledger.page(window);
        expect(result.requests).toEqual([request(), { ...request(), source: "other-upstream" }]);
        expect(result.next).toBeNull();
      }),
    ),
  );

  it.effect("retains only the schema's fields, including for nested private metadata", () =>
    inMemory(
      Effect.gen(function* () {
        const stored = request();
        yield* Ledger.append({
          ...stored,
          title: "Private title must never survive",
          prompt: "Private content",
          path: "/a/private/path",
          authorization: "secret",
          attribution: { ...stored.attribution, title: "Nested private title" },
        });
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{ record: string }>`SELECT record FROM usage_ledger`;
        expect(rows.map(({ record }) => JSON.parse(record))).toEqual([stored]);
        expect((yield* Ledger.page(window)).requests).toEqual([stored]);
      }),
    ),
  );

  it.effect("does not invent thread metadata or a zero cost for local usage", () =>
    inMemory(
      Effect.gen(function* () {
        const local = {
          ...request(),
          attribution: {
            _tag: "local",
            poolOwnerId: "pool-owner",
            poolId: "team-pool",
            userId: "requester",
            keyId: "local-key",
          },
          tokens: null,
          pricing: null,
          quotaAfter: null,
          accountId: null,
          lenderId: null,
        } satisfies Ledger.UsageRequest;
        yield* Ledger.append(local);
        expect((yield* Ledger.page(window)).requests).toEqual([local]);
        const sql = yield* SqlClient.SqlClient;
        expect(yield* sql`SELECT thread_id, run_id FROM usage_ledger`).toEqual([
          { thread_id: null, run_id: null },
        ]);
      }),
    ),
  );

  it.effect("rejects invalid measurements before writing", () =>
    inMemory(
      Effect.gen(function* () {
        for (const invalid of [
          { ...request(), at: -1 },
          { ...request(), tokens: { ...request().tokens, outputTokens: -1 } },
          { ...request(), latencyMs: Number.POSITIVE_INFINITY },
          { ...request(), quotaAfter: { fiveHourUsedPercent: 101, weeklyUsedPercent: 0 } },
          { ...request(), pricing: { version: "", costUsd: 1 } },
        ]) {
          expect((yield* Ledger.append(invalid).pipe(Effect.flip))._tag).toBe(
            "UsageLedgerInputError",
          );
        }
        expect((yield* Ledger.page(window)).requests).toEqual([]);
      }),
    ),
  );

  it.effect("pages equal timestamps without skips and excludes the end of the period", () =>
    inMemory(
      Effect.gen(function* () {
        for (const id of ["3", "1", "2"]) yield* Ledger.append(request(id));
        yield* Ledger.append({ ...request("end"), at: window.until });
        const first = yield* Ledger.page({ ...window, limit: 2 });
        expect(first.requests.map((row) => row.requestId)).toEqual(["1", "2"]);
        expect(first.next).toEqual({ at: AT, source: "cliproxyapi", requestId: "2" });
        const second = yield* Ledger.page({ ...window, limit: 2, after: first.next! });
        expect(second.requests.map((row) => row.requestId)).toEqual(["3"]);
        expect(second.next).toBeNull();
        for (const invalid of [
          { ...window, limit: 501 },
          { ...window, limit: 0 },
          { ...window, until: window.since - 1 },
        ]) {
          expect((yield* Ledger.page(invalid).pipe(Effect.flip))._tag).toBe(
            "UsageLedgerInputError",
          );
        }
      }),
    ),
  );

  it.effect("survives reopen and quota-history clearing without any thread database", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped();
      const filename = path.join(dir, "pool.sqlite");
      const open = () =>
        NodeSqliteClient.layer({ filename, readerWorker: false, checkpointWorker: false });
      yield* Effect.gen(function* () {
        yield* Ledger.createTable;
        yield* History.createTables;
        yield* History.addSampling;
        yield* Ledger.append(request());
      }).pipe(Effect.provide(open()));
      yield* Effect.gen(function* () {
        yield* History.clear;
        expect((yield* Ledger.page(window)).requests).toEqual([request()]);
        expect(yield* Ledger.append(request())).toBe(false);
      }).pipe(Effect.provide(open()));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("creates the ledger through the real pool migrations", () => {
    const { api, runtime } = makeMemoryPoolObject();
    return Effect.gen(function* () {
      yield* Effect.promise(() =>
        api.create({ userId: "owner" }, { name: "Pool", personal: true }),
      );
      yield* Effect.promise(() => runtime.runPromise(Ledger.append(request())));
      expect(
        (yield* Effect.promise(() => runtime.runPromise(Ledger.page(window)))).requests,
      ).toEqual([request()]);
    }).pipe(Effect.ensuring(Effect.promise(() => runtime.dispose())));
  });
});
