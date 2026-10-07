import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";

import { fetchTurns, toReplayTurn } from "./workload-events.ts";
import type { MachinePrice } from "./workload-prices.ts";
import { cloudCpuSeconds, formatReplayTable, replay, type ReplayTurn } from "./workload-replay.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeQueryBody = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ query: Schema.Struct({ query: Schema.String }) })),
);
const DAY_ONE = Date.parse("2026-10-01T10:00:00Z");
const turn = (input: Partial<ReplayTurn> & { readonly endedAt: number }): ReplayTurn => ({
  userId: "user-a",
  threadId: "thread-1",
  durationSeconds: 60,
  commandSeconds: 0,
  cpuSeconds: undefined,
  ...input,
  endedAtMs: DAY_ONE + input.endedAt * 1000,
});

// $1 per awake hour, $10 per vCPU-hour used.
const PRICE: MachinePrice = {
  id: "test",
  label: "Test",
  checkedOn: "2026-10-06",
  source: "test",
  shape: { vcpu: 2, memoryGiB: 4, diskGB: 0 },
  activeCpuPerVcpuHour: 10,
  awakePerHour: 1,
};

describe("replay", () => {
  it("keeps a thread's machine awake across gaps shorter than the idle tail", () => {
    // Turns end at 60 s and 400 s, so the gap is 400 - 60 - 60 = 280 s.
    const turns = [turn({ endedAt: 60 }), turn({ endedAt: 400 })];
    const [short, long] = replay(turns, [PRICE], [100, 300]).rows;

    // 100 s tail: two wakes; each turn's 60 s plus a full tail.
    assert.strictEqual(short?.wakes, 2);
    assert.closeTo((short?.awakeHours ?? 0) * 3600, 60 + 100 + 60 + 100, 1e-6);
    // 300 s tail: one wake; the gap stays awake, then one tail at the end.
    assert.strictEqual(long?.wakes, 1);
    assert.closeTo((long?.awakeHours ?? 0) * 3600, 60 + 280 + 60 + 300, 1e-6);
  });

  it("prices measured CPU where the server sampled it, and assumes it elsewhere", () => {
    assert.strictEqual(cloudCpuSeconds(turn({ endedAt: 0, cpuSeconds: 30 })), 60);
    assert.strictEqual(
      cloudCpuSeconds(turn({ endedAt: 0, durationSeconds: 100, commandSeconds: 10 })),
      100 * 0.05 + 10 * 2 * 1.5,
    );
  });

  it("divides cost by active user-days and drops stuck turns", () => {
    const turns = [
      turn({ endedAt: 60, cpuSeconds: 1_800 }),
      turn({ endedAt: 60, userId: "user-b", threadId: "thread-2", cpuSeconds: 0 }),
      turn({ endedAt: 86_400 + 60, threadId: "thread-3", cpuSeconds: 0 }),
      turn({ endedAt: 90_000, threadId: "thread-4", durationSeconds: 7 * 3600 }),
    ];
    const result = replay(turns, [PRICE], [0]);
    assert.strictEqual(result.turns, 3);
    assert.strictEqual(result.userDays, 3);
    assert.strictEqual(result.measuredCpuTurns, 3);
    // 3 minutes awake ($0.05) and one cloud CPU-hour ($10), over 3 user-days.
    assert.closeTo(result.rows[0]?.costPerUserDay.get("test") ?? 0, (0.05 + 10) / 3, 1e-9);
  });

  it("formats #116's table", () => {
    const table = formatReplayTable(
      replay([turn({ endedAt: 60, cpuSeconds: 0 })], [PRICE], [30, 600]),
      [PRICE],
    );
    assert.strictEqual(
      table,
      [
        "| Idle tail before stop | VM awake h | Wakes | Test |",
        "|---|---|---|---|",
        "| 30 s | 0 | 1 | $0.025/day |",
        "| 10 min | 0 | 1 | $0.183/day |",
      ].join("\n"),
    );
  });
});

describe("toReplayTurn", () => {
  it("reads PostHog's rows, where nested properties can arrive as JSON text", () => {
    assert.deepStrictEqual(
      toReplayTurn({
        distinct_id: "user-a",
        timestamp: "2026-10-01T10:01:00Z",
        properties: {
          threadHash: "abc",
          durationSeconds: 60,
          commandSeconds: { install: 20, test: 5 },
          processCpuSeconds: null,
        },
      }),
      {
        userId: "user-a",
        threadId: "abc",
        endedAtMs: Date.parse("2026-10-01T10:01:00Z"),
        durationSeconds: 60,
        commandSeconds: 25,
        cpuSeconds: undefined,
      },
    );
  });
});

describe("fetchTurns", () => {
  it.effect("pages through PostHog's HogQL results with the personal key", () =>
    Effect.gen(function* () {
      const requests: Array<{ url: string; auth: string | undefined; query: string }> = [];
      const row = (threadHash: string) => [
        "user-a",
        Date.parse("2026-10-01T10:01:00Z"),
        // HogQL returns the properties column as JSON text.
        encodeJson({ threadHash, durationSeconds: 60, commandSeconds: { test: 5 } }),
      ];
      const client = HttpClient.make((request) =>
        Effect.gen(function* () {
          const body =
            request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
          const query = (yield* decodeQueryBody(body).pipe(Effect.orDie)).query.query;
          requests.push({ url: request.url, auth: request.headers.authorization, query });
          const results = query.includes("OFFSET 0") ? [row("t1"), row("t2")] : [row("t3")];
          return HttpClientResponse.fromWeb(request, Response.json({ results }));
        }),
      );

      const turns = yield* fetchTurns(30, 2).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(HttpClient.HttpClient, client),
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                POSTHOG_PERSONAL_API_KEY: "phx_test",
                POSTHOG_PROJECT_ID: "641467",
              }),
            ),
          ),
        ),
      );

      assert.deepStrictEqual(
        turns.map((turn) => [turn.threadId, turn.commandSeconds]),
        [
          ["t1", 5],
          ["t2", 5],
          ["t3", 5],
        ],
      );
      assert.strictEqual(requests.length, 2);
      assert.strictEqual(requests[0]?.url, "https://us.posthog.com/api/projects/641467/query/");
      assert.strictEqual(requests[0]?.auth, "Bearer phx_test");
      assert.include(requests[0]?.query ?? "", "INTERVAL 30 DAY");
    }),
  );
});
