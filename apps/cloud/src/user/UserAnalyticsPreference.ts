import { type ProductAnalyticsSettings } from "@t3tools/contracts/signalboxAnalytics";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

export const createTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE user_analytics_preference (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1))
  )`;
});

export class UserAnalyticsPreference extends Context.Service<
  UserAnalyticsPreference,
  {
    readonly settings: Effect.Effect<ProductAnalyticsSettings, SqlError>;
    readonly setEnabled: (enabled: boolean) => Effect.Effect<ProductAnalyticsSettings, SqlError>;
  }
>()("@signalbox/cloud/user/UserAnalyticsPreference") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const decodeRows = Schema.decodeUnknownEffect(
    Schema.Array(Schema.Struct({ enabled: Schema.Literals([0, 1]) })),
  );
  const settings = Effect.gen(function* () {
    const rows = yield* sql`SELECT enabled FROM user_analytics_preference WHERE id = 1`;
    const [row] = yield* decodeRows(rows).pipe(Effect.orDie);
    // Store consent independently of delivery. No cloud PostHog sender runs before #358.
    return { enabled: row?.enabled === 1, disabledByServer: false };
  });
  const setEnabled: UserAnalyticsPreference["Service"]["setEnabled"] = (enabled) =>
    Effect.gen(function* () {
      yield* sql`INSERT INTO user_analytics_preference (id, enabled) VALUES (1, ${enabled ? 1 : 0})
        ON CONFLICT (id) DO UPDATE SET enabled = excluded.enabled`;
      return { enabled, disabledByServer: false };
    });
  return UserAnalyticsPreference.of({ settings, setEnabled });
});

export const layer = Layer.effect(UserAnalyticsPreference, make);
