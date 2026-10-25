import type { PersonTimezoneSettings } from "@t3tools/contracts/personTimezone";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

export const createTables = SqlClient.SqlClient.use(
  (sql) => sql`
  CREATE TABLE user_timezone (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    device_timezone TEXT,
    manual_timezone TEXT
  )
`,
);

export class UserTimezone extends Context.Service<
  UserTimezone,
  {
    readonly settings: Effect.Effect<PersonTimezoneSettings, SqlError>;
    readonly timezone: Effect.Effect<string, SqlError>;
    readonly set: (timezone: string | null) => Effect.Effect<PersonTimezoneSettings, SqlError>;
    readonly report: (timezone: string) => Effect.Effect<PersonTimezoneSettings, SqlError>;
  }
>()("@signalbox/cloud/user/UserTimezone") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const settings = Effect.gen(function* () {
    const [row] = yield* sql<{
      readonly device_timezone: string | null;
      readonly manual_timezone: string | null;
    }>`SELECT device_timezone, manual_timezone FROM user_timezone WHERE id = 1`;
    return {
      timezone: row?.manual_timezone ?? row?.device_timezone ?? "UTC",
      source: row?.manual_timezone == null ? ("device" as const) : ("manual" as const),
      deviceTimezone: row?.device_timezone ?? null,
    };
  });
  const set: UserTimezone["Service"]["set"] = (timezone) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`INSERT INTO user_timezone (id, manual_timezone) VALUES (1, ${timezone})
        ON CONFLICT (id) DO UPDATE SET manual_timezone = excluded.manual_timezone`;
        return yield* settings;
      }),
    );
  const report: UserTimezone["Service"]["report"] = (timezone) =>
    sql.withTransaction(
      Effect.gen(function* () {
        // A client changing zones must never undo the person's explicit choice.
        yield* sql`INSERT INTO user_timezone (id, device_timezone) VALUES (1, ${timezone})
        ON CONFLICT (id) DO UPDATE SET device_timezone = excluded.device_timezone`;
        return yield* settings;
      }),
    );
  return UserTimezone.of({
    settings,
    timezone: Effect.map(settings, (value) => value.timezone),
    set,
    report,
  });
});

export const layer = Layer.effect(UserTimezone, make);
