import { RelayAgentAwarenessPreferences } from "@t3tools/contracts/relay";
import type { SignalboxPushDeviceRegistration } from "@t3tools/contracts/signalboxPush";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

/**
 * The phones a person gets pushes on, in their own object. A phone registers
 * through the session it signed in with, and pushes reach it only while that
 * session lives: signing out or revoking the session silences it without the
 * phone having to say goodbye (`PushNotifier` drops it on the next push).
 */

/** More than anyone carries; stops one session from filling the user's storage. */
export const MAX_DEVICES = 20;

export interface PushDevice {
  readonly deviceId: string;
  /** The session that registered it. */
  readonly sid: string;
  readonly platform: "ios" | "android";
  readonly pushToken: string;
  /** The APNs topic or the FCM package; null on older app builds. */
  readonly bundleId: string | null;
  readonly apsEnvironment: "sandbox" | "production";
  readonly preferences: RelayAgentAwarenessPreferences;
}

export class PushDevices extends Context.Service<
  PushDevices,
  {
    /**
     * Saves the phone for `sid`. A registration without a push token (no
     * permission, notifications off) forgets it instead.
     */
    readonly register: (
      sid: string,
      registration: SignalboxPushDeviceRegistration,
    ) => Effect.Effect<void, SqlError>;
    readonly remove: (deviceId: string) => Effect.Effect<void, SqlError>;
    readonly list: Effect.Effect<ReadonlyArray<PushDevice>, SqlError>;
  }
>()("@signalbox/cloud/push/PushDevices") {}

/** `UserStore`'s `0014` migration. */
export const createTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE push_devices (
    device_id TEXT PRIMARY KEY,
    sid TEXT NOT NULL,
    platform TEXT NOT NULL,
    push_token TEXT NOT NULL,
    bundle_id TEXT,
    aps_environment TEXT NOT NULL,
    preferences TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`;
});

const PreferencesJson = Schema.fromJsonString(RelayAgentAwarenessPreferences);
const encodePreferences = Schema.encodeSync(PreferencesJson);
/** A row that no longer decodes (say, older preferences) is skipped, not fatal. */
const decodeRow = Schema.decodeUnknownOption(
  Schema.Struct({
    device_id: Schema.String,
    sid: Schema.String,
    platform: Schema.Literals(["ios", "android"]),
    push_token: Schema.String,
    bundle_id: Schema.NullOr(Schema.String),
    aps_environment: Schema.Literals(["sandbox", "production"]),
    preferences: PreferencesJson,
  }),
);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const remove: PushDevices["Service"]["remove"] = (deviceId) =>
    Effect.asVoid(sql`DELETE FROM push_devices WHERE device_id = ${deviceId}`);

  const register: PushDevices["Service"]["register"] = Effect.fn("PushDevices.register")(function* (
    sid,
    registration,
  ) {
    if (registration.pushToken === undefined) return yield* remove(registration.deviceId);
    const now = yield* Clock.currentTimeMillis;
    yield* sql`INSERT INTO push_devices
          (device_id, sid, platform, push_token, bundle_id, aps_environment, preferences, updated_at)
        VALUES (${registration.deviceId}, ${sid}, ${registration.platform},
          ${registration.pushToken}, ${registration.bundleId ?? null},
          ${registration.apsEnvironment ?? "production"},
          ${encodePreferences(registration.preferences)}, ${now})
        ON CONFLICT (device_id) DO UPDATE SET sid = excluded.sid, platform = excluded.platform,
          push_token = excluded.push_token, bundle_id = excluded.bundle_id,
          aps_environment = excluded.aps_environment, preferences = excluded.preferences,
          updated_at = excluded.updated_at`;
    // A reinstall gets a new device id but may keep its token: one phone, one push.
    yield* sql`DELETE FROM push_devices
      WHERE push_token = ${registration.pushToken} AND device_id <> ${registration.deviceId}`;
    // The least recently registered go first.
    yield* sql`DELETE FROM push_devices WHERE device_id NOT IN (
        SELECT device_id FROM push_devices ORDER BY updated_at DESC LIMIT ${MAX_DEVICES})`;
  }, sql.withTransaction);

  const list: PushDevices["Service"]["list"] = sql`SELECT device_id, sid, platform, push_token,
      bundle_id, aps_environment, preferences FROM push_devices ORDER BY device_id`.pipe(
    Effect.map((rows) =>
      rows.flatMap((raw): Array<PushDevice> =>
        Option.match(decodeRow(raw), {
          onNone: () => [],
          onSome: (row) => [
            {
              deviceId: row.device_id,
              sid: row.sid,
              platform: row.platform,
              pushToken: row.push_token,
              bundleId: row.bundle_id,
              apsEnvironment: row.aps_environment,
              preferences: row.preferences,
            },
          ],
        }),
      ),
    ),
  );

  return PushDevices.of({ register, remove, list });
});

export const layer = Layer.effect(PushDevices, make);
