import { AutomationError } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { toJson } from "@signalbox/automations/json";
import * as SqlClient from "effect/sql/SqlClient";

/** Accepted requests stay here until delivery succeeds. Completed ids are kept for one day. */
interface DeliveryRow {
  readonly id: string;
  readonly kind: "automation" | "callback" | "github";
  readonly target: string;
  readonly payload: string;
  readonly attempts: number;
}

const RETENTION_MS = 24 * 60 * 60_000;
const BATCH = 20;
const storageError = (cause: unknown) =>
  new AutomationError({ message: "Couldn't store a webhook delivery.", cause });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  yield* sql`CREATE TABLE IF NOT EXISTS signalbox_cloud_hook_secrets (
    hook_id TEXT PRIMARY KEY, secret TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS signalbox_cloud_hook_inbox (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, target TEXT NOT NULL,
    request_key TEXT NOT NULL, payload TEXT NOT NULL, received_at INTEGER NOT NULL,
    next_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
    UNIQUE (target, request_key)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS signalbox_cloud_hook_inbox_due
    ON signalbox_cloud_hook_inbox (next_at)`;

  const wrap = <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.mapError(storageError));

  const secret = (hookId: string) =>
    wrap(
      sql<{ readonly secret: string }>`SELECT secret FROM signalbox_cloud_hook_secrets
        WHERE hook_id = ${hookId}`.pipe(Effect.map((rows) => rows[0]?.secret ?? null)),
    );
  const setSecret = (hookId: string, value: string | null) =>
    wrap(
      (value === null
        ? sql`DELETE FROM signalbox_cloud_hook_secrets WHERE hook_id = ${hookId}`
        : sql`INSERT INTO signalbox_cloud_hook_secrets (hook_id, secret)
            VALUES (${hookId}, ${value})
            ON CONFLICT (hook_id) DO UPDATE SET secret = excluded.secret`
      ).pipe(Effect.asVoid),
    );

  const enqueue = (input: {
    readonly kind: DeliveryRow["kind"];
    readonly target: string;
    readonly key: string | undefined;
    readonly payload: unknown;
    readonly maxPerMinute?: number;
  }) =>
    wrap(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const id = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
        const key = input.key ?? id;
        yield* sql`DELETE FROM signalbox_cloud_hook_inbox
          WHERE next_at IS NULL AND received_at < ${now - RETENTION_MS}`;
        const previous = (yield* sql<{ readonly id: string }>`
          SELECT id FROM signalbox_cloud_hook_inbox
          WHERE target = ${input.target} AND request_key = ${key}`)[0];
        if (previous) return { status: 202 as const, deliveryId: previous.id, duplicate: true };
        if (input.maxPerMinute !== undefined) {
          const recent = yield* sql<{ readonly count: number }>`
            SELECT COUNT(*) AS count FROM signalbox_cloud_hook_inbox
            WHERE target = ${input.target} AND received_at > ${now - 60_000}`;
          if ((recent[0]?.count ?? 0) >= input.maxPerMinute) return { status: 429 as const };
        }
        const inserted = yield* sql<{ readonly id: string }>`
          INSERT INTO signalbox_cloud_hook_inbox
            (id, kind, target, request_key, payload, received_at, next_at)
          VALUES (${id}, ${input.kind}, ${input.target}, ${key},
            ${toJson(input.payload)}, ${now}, ${now})
          ON CONFLICT (target, request_key) DO NOTHING RETURNING id`;
        const existing =
          inserted[0] ??
          (yield* sql<{ readonly id: string }>`
          SELECT id FROM signalbox_cloud_hook_inbox
          WHERE target = ${input.target} AND request_key = ${key}`)[0];
        if (!existing) return yield* Effect.die("The webhook claim disappeared.");
        return { status: 202 as const, deliveryId: existing.id, duplicate: inserted.length === 0 };
      }).pipe(sql.withTransaction),
    );

  const nextAt = wrap(
    sql<{ readonly at: number | null }>`SELECT MIN(next_at) AS at
      FROM signalbox_cloud_hook_inbox`.pipe(Effect.map((rows) => rows[0]?.at ?? null)),
  );

  const drain = (deliver: (row: DeliveryRow) => Effect.Effect<void, AutomationError>) =>
    wrap(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const rows = yield* sql<DeliveryRow>`SELECT id, kind, target, payload, attempts
          FROM signalbox_cloud_hook_inbox WHERE next_at <= ${now}
          ORDER BY received_at, rowid LIMIT ${BATCH}`;
        for (const row of rows) {
          const result = yield* deliver(row).pipe(Effect.result);
          if (result._tag === "Success") {
            // Keep only the receipt after delivery; request content needn't live for dedupe.
            yield* sql`UPDATE signalbox_cloud_hook_inbox SET next_at = NULL, payload = 'null'
              WHERE id = ${row.id}`;
          } else {
            const next = now + Math.min(3_600_000, 10_000 * 2 ** Math.min(row.attempts, 9));
            yield* sql`UPDATE signalbox_cloud_hook_inbox SET next_at = ${next},
              attempts = attempts + 1 WHERE id = ${row.id}`;
            yield* Effect.logWarning("Webhook delivery will retry", {
              "webhook.delivery_id": row.id,
              "webhook.attempt": row.attempts + 1,
            });
          }
        }
      }),
    );

  return { secret, setSecret, enqueue, nextAt, drain };
});

export class HookStore extends Context.Service<HookStore, Effect.Success<typeof make>>()(
  "@signalbox/cloud/automations/hookStore",
) {}

/** Durable Object storage encrypts the signing secrets at rest, like pool credentials. */
export const layer = Layer.effect(HookStore, make.pipe(Effect.mapError(storageError)));
