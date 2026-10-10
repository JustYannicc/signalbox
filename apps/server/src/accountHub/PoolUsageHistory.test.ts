import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, type UsageLimitSourceSnapshot } from "@t3tools/contracts";
import { type AccountPool, AccountPoolId, poolSourceId } from "@t3tools/contracts/accountHub";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as UsageLimitSources from "../usage/UsageLimitSources.ts";
import * as AccountPools from "./AccountPools.ts";
import * as PoolUsageHistory from "./PoolUsageHistory.ts";
import { HOUR_MS } from "./poolUsageRecording.ts";

const NOW = Date.parse("2026-10-05T08:00:00.000Z");
const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));
const RESETS_AT = iso(NOW + 6 * 24 * HOUR_MS);

const pool: AccountPool = {
  id: AccountPoolId.make("team"),
  name: "Team",
  sourceId: poolSourceId("team"),
  backing: { mode: "managed" },
  personal: false,
};

/** The team pool's one Claude account with `used` of its weekly window spent. */
const snapshot = (used: number): ReadonlyArray<UsageLimitSourceSnapshot> => [
  {
    id: pool.sourceId,
    kind: "cliproxy",
    label: "Team",
    checkedAt: iso(NOW),
    accounts: [
      {
        id: "claude-a.json",
        driver: ProviderDriverKind.make("claudeAgent"),
        usageLimits: {
          checkedAt: iso(NOW),
          windows: [
            {
              id: "seven_day",
              kind: "weekly",
              label: "Weekly",
              usedPercent: used,
              resetsAt: RESETS_AT,
            },
          ],
        },
      },
    ],
  },
];

/**
 * Reads of the pool's accounts the test hands over one at a time; each
 * resolves once the history service has recorded it and asked for the next.
 */
const makeReads = Effect.gen(function* () {
  const queue = yield* Queue.unbounded<{
    readonly sources: ReadonlyArray<UsageLimitSourceSnapshot>;
    readonly recorded: Deferred.Deferred<void>;
  }>();
  let previous: Deferred.Deferred<void> | undefined;
  const changes = Stream.fromEffectRepeat(
    Effect.gen(function* () {
      if (previous) yield* Deferred.succeed(previous, undefined);
      const next = yield* Queue.take(queue);
      previous = next.recorded;
      return next.sources;
    }),
  );
  const read = (sources: ReadonlyArray<UsageLimitSourceSnapshot>) =>
    Effect.gen(function* () {
      const recorded = yield* Deferred.make<void>();
      yield* Queue.offer(queue, { sources, recorded });
      yield* Deferred.await(recorded);
    });
  return { changes, read };
});

const historyLayer = (
  databasePath: string,
  current: ReadonlyArray<UsageLimitSourceSnapshot>,
  changes: Stream.Stream<ReadonlyArray<UsageLimitSourceSnapshot>>,
) =>
  PoolUsageHistory.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(UsageLimitSources.UsageLimitSources)({
          current: Effect.succeed(current),
          streamChanges: changes,
          refresh: Effect.void,
        }),
        Layer.mock(AccountPools.AccountPools)({
          list: Effect.succeed([pool]),
          listChanges: Stream.never,
        }),
        SqlitePersistence.layerFromPath(databasePath).pipe(Layer.provide(NodeServices.layer)),
      ),
    ),
  );

it.effect("advises from history recorded before a restart", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "signalbox-pool-usage-" });
    const databasePath = path.join(directory, "state.sqlite");

    // Thirty hours of the pool using 2% of its account's week an hour.
    const start = NOW - 30 * HOUR_MS;
    // Before the service starts, so its timers don't tick through every quarter hour since 1970.
    yield* TestClock.setTime(start);
    yield* Effect.gen(function* () {
      const reads = yield* makeReads;
      yield* Effect.gen(function* () {
        yield* PoolUsageHistory.PoolUsageHistory;
        for (let hour = 0; hour <= 30; hour++) {
          yield* TestClock.setTime(start + hour * HOUR_MS);
          yield* reads.read(snapshot(2 * hour));
        }
      }).pipe(Effect.provide(historyLayer(databasePath, [], reads.changes)), Effect.scoped);
    });

    // After the restart, the same history drives the forecast.
    const advice = yield* Effect.gen(function* () {
      const history = yield* PoolUsageHistory.PoolUsageHistory;
      return yield* history.advice.pipe(Stream.take(1), Stream.runCollect);
    }).pipe(Effect.provide(historyLayer(databasePath, snapshot(60), Stream.never)), Effect.scoped);

    assert.deepStrictEqual(advice, [
      [
        {
          poolId: pool.id,
          providers: [
            {
              driver: ProviderDriverKind.make("claudeAgent"),
              historyHours: 30,
              // 40% left at 2% an hour.
              runsOut: {
                at: iso(NOW + 20 * HOUR_MS),
                window: "Weekly",
                backAt: RESETS_AT,
              },
              addAccounts: 3,
            },
          ],
        },
      ],
    ]);
  }).pipe(Effect.provide(NodeServices.layer)),
);
