import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, type UsageLimitSourceAccount } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  HOUR_MS,
  accountWindowKey,
  recordRead,
  type AccountWindowState,
} from "@t3tools/shared/poolUsageRecording";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as History from "./poolUsageHistory.ts";

const START = Date.parse("2026-10-05T08:00:00.000Z");
const iso = (at: number) => DateTime.formatIso(DateTime.makeUnsafe(at));
const account = (used: number, at: number): UsageLimitSourceAccount => ({
  id: "claude-a.json",
  driver: ProviderDriverKind.make("claudeAgent"),
  usageLimits: {
    checkedAt: iso(at),
    windows: [
      {
        id: "seven_day",
        kind: "weekly",
        label: "Weekly",
        usedPercent: used,
        resetsAt: iso(START + 7 * 24 * HOUR_MS),
      },
    ],
  },
});

const inMemory = <A, E, R>(effect: Effect.Effect<A, E, R | SqlClient.SqlClient>) =>
  Effect.gen(function* () {
    yield* History.createTables;
    yield* History.addSampling;
    return yield* effect;
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })));

describe("durable pool usage history", () => {
  it.effect("keeps the baseline through pause, sign-out and temporarily missing quota", () =>
    inMemory(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        let previous = new Map<string, AccountWindowState>();
        let baselineTotal = 0;
        const read = (accounts: ReadonlyArray<UsageLimitSourceAccount>, now: number) =>
          Effect.gen(function* () {
            const baseline = recordRead({ previous, pools: [{ poolId: "pool", accounts }], now });
            for (const state of baseline.states)
              previous.set(accountWindowKey(state.poolId, state.accountId, state.windowId), state);
            baselineTotal += baseline.hours.reduce((sum, hour) => sum + hour.consumed, 0);
            yield* History.record(accounts, now, ["claude-a.json"]);
            expect(
              yield* sql<{ total: number }>`SELECT sum(consumed) AS total FROM usage_hours`,
            ).toEqual([{ total: baselineTotal }]);
          });
        const quota = (used: number, at: number, disabled = false, signedOut = false) =>
          History.accountsWithQuota([
            {
              name: "claude-a.json",
              type: "claude",
              disabled,
              signedOut,
              usageLimits: account(used, at).usageLimits,
            },
          ]);
        yield* read(quota(10, START), START);
        yield* read(quota(20, START + HOUR_MS, true), START + HOUR_MS);
        yield* read(quota(30, START + 2 * HOUR_MS, false, true), START + 2 * HOUR_MS);
        yield* read([], START + 3 * HOUR_MS);
        expect(yield* sql`SELECT used FROM usage_accounts`).toEqual([{ used: 30 }]);
        yield* read(quota(50, START + 4 * HOUR_MS), START + 4 * HOUR_MS);
        expect(baselineTotal).toBe(40);
        // Only disappearance from the live account list removes the prior observation.
        yield* History.record([], START + 5 * HOUR_MS, []);
        expect(yield* sql`SELECT * FROM usage_accounts`).toEqual([]);
      }),
    ),
  );

  it.effect("distinguishes missing quota, insufficient history and measured zero use", () =>
    inMemory(
      Effect.gen(function* () {
        const missing = {
          ...account(0, START),
          usageLimits: { checkedAt: iso(START), windows: [] },
        };
        yield* History.record([missing], START);
        expect(yield* History.advice([missing], START)).toEqual([]);
        yield* History.record([account(0, START)], START);
        expect(yield* History.advice([account(0, START)], START)).toEqual([
          { driver: "claudeAgent", historyHours: 0, addAccounts: 0 },
        ]);
        const later = START + 24 * HOUR_MS;
        yield* History.record([account(0, later)], later);
        expect(yield* History.advice([account(0, later)], later)).toEqual([
          { driver: "claudeAgent", historyHours: 24, addAccounts: 0 },
        ]);
        yield* History.record([account(0, later)], later + HOUR_MS);
        expect(yield* History.advice([account(0, later)], later + HOUR_MS)).toEqual([
          { driver: "claudeAgent", historyHours: 24, addAccounts: 0 },
        ]);
      }),
    ),
  );

  it.effect("reopens the database with the previous observation and forecasts recorded use", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped();
      const filename = path.join(dir, "history.sqlite");
      const open = () =>
        NodeSqliteClient.layer({ filename, readerWorker: false, checkpointWorker: false });
      yield* Effect.gen(function* () {
        yield* History.createTables;
        yield* History.addSampling;
        yield* History.record([account(2, START)], START);
      }).pipe(Effect.provide(open()));
      const now = START + 24 * HOUR_MS;
      yield* Effect.gen(function* () {
        expect(yield* History.nextSampleAt(now)).toBe(START + History.SAMPLE_EVERY_MS);
        yield* History.record([account(50, now)], now);
        expect(yield* History.nextSampleAt(now)).toBe(now + History.SAMPLE_EVERY_MS);
        const expected = [
          {
            driver: "claudeAgent",
            historyHours: 24,
            addAccounts: 3,
            runsOut: {
              at: iso(now + 25 * HOUR_MS),
              window: "Weekly",
              backAt: iso(START + 7 * 24 * HOUR_MS),
            },
          },
        ];
        expect(yield* History.advice([account(50, now)], now)).toEqual(expected);
        // Republishing the same quota after reopening cannot count its use twice.
        yield* History.record([account(50, now)], now + HOUR_MS);
        const sql = yield* SqlClient.SqlClient;
        expect(
          yield* sql<{ total: number }>`SELECT sum(consumed) AS total FROM usage_hours`,
        ).toEqual([{ total: 48 }]);
      }).pipe(Effect.provide(open()));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("prunes old observations and hours and clears a replaced backing", () =>
    inMemory(
      Effect.gen(function* () {
        yield* History.record([account(10, START)], START);
        const now = START + 36 * 24 * HOUR_MS;
        yield* History.record([], now);
        const sql = yield* SqlClient.SqlClient;
        expect(yield* sql`SELECT * FROM usage_accounts`).toEqual([]);
        expect(yield* sql`SELECT * FROM usage_hours`).toEqual([]);
        // A stale cached quota must not grow expired history again.
        yield* History.record([account(10, START)], now);
        expect(yield* sql`SELECT * FROM usage_accounts`).toEqual([]);
        expect(yield* sql`SELECT * FROM usage_hours`).toEqual([]);
        yield* History.record([account(10, START)], START);
        yield* History.clear;
        expect(yield* sql`SELECT * FROM usage_accounts`).toEqual([]);
        expect(yield* sql`SELECT * FROM usage_hours`).toEqual([]);
      }),
    ),
  );
});
