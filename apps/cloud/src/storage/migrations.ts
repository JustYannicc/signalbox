// @effect-diagnostics anyUnknownInErrorContext:off - Migrator types a migration and its loader as failing with anything; a failure dies, as in Migrator.
/**
 * Applies a Durable Object's SQLite migrations by id and name (`0009_links`
 * is recorded as 9, "links") rather than by highest id. Effect's Migrator
 * skips every id at or below the latest one recorded, so an object that once
 * ran a tried branch's `0009_a` would never run main's `0009_b`. Here every
 * migration in the record not recorded yet runs, in id order, each in its own
 * transaction.
 *
 *   const migrate = Migrations.run(Migrator.fromRecord({ "0001_init": ... }));
 *
 * Records stay in Migrator's own `effect_sql_migrations` table. Its primary
 * key is the id alone, which can't hold two migrations with one id, so the
 * first run rebuilds it keyed by (id, name) with every row unchanged: objects
 * the old runner migrated re-run nothing, and Migrator still works against it.
 */
import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

const TABLE = "effect_sql_migrations";

/** Unambiguous: ids are digits, so the first `_` ends one. */
const fullName = (id: number, name: string) => `${id}_${name}`;

const createTable = (sql: SqlClient.SqlClient, table: string) =>
  sql`CREATE TABLE IF NOT EXISTS ${sql(table)} (
    migration_id integer NOT NULL,
    created_at datetime NOT NULL DEFAULT current_timestamp,
    name VARCHAR(255) NOT NULL,
    PRIMARY KEY (migration_id, name)
  )`;

/** Creates the table, or rebuilds Migrator's id-keyed one in place. */
const ensureTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{
    readonly name: string;
    readonly pk: number;
  }>`PRAGMA table_info(${sql(TABLE)})`.withoutTransform;
  if (columns.length === 0) return yield* createTable(sql, TABLE);
  if (columns.some((column) => column.name === "name" && column.pk > 0)) return;
  const next = `${TABLE}_by_name`;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* createTable(sql, next);
      yield* sql`INSERT INTO ${sql(next)} (migration_id, created_at, name)
        SELECT migration_id, created_at, name FROM ${sql(TABLE)}`;
      yield* sql`DROP TABLE ${sql(TABLE)}`;
      yield* sql`ALTER TABLE ${sql(next)} RENAME TO ${sql(TABLE)}`;
    }),
  );
});

const isConstraintConflict = (error: SqlError) =>
  error.reason._tag === "ConstraintError" || error.reason._tag === "UniqueViolation";

const load = ([id, name, effect]: Migrator.ResolvedMigration) =>
  effect.pipe(
    Effect.catchDefect((defect) =>
      Effect.fail(
        new Migrator.MigrationError({
          kind: "ImportError",
          message: `Could not import migration "${fullName(id, name)}"\n\n${defect}`,
        }),
      ),
    ),
    Effect.filterOrFail(
      (migration): migration is Effect.Effect<unknown, unknown, SqlClient.SqlClient> =>
        Effect.isEffect(migration),
      () =>
        new Migrator.MigrationError({
          kind: "ImportError",
          message: `Migration "${fullName(id, name)}" is not an Effect`,
        }),
    ),
  );

/**
 * Applies every migration of `loader` not recorded yet and returns the ones it
 * ran. Like Migrator, a failing migration dies and rolls back, its own
 * transaction only: the ones before it stay applied, and it runs again on the
 * next start. A record left by a migration that is no longer in the loader,
 * such as an abandoned branch's, stays and is ignored.
 */
export const run = (
  loader: Migrator.Loader,
): Effect.Effect<
  ReadonlyArray<readonly [id: number, name: string]>,
  Migrator.MigrationError | SqlError,
  SqlClient.SqlClient
> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* ensureTable;

    const migrations = yield* loader;
    const names = new Set(migrations.map(([id, name]) => fullName(id, name)));
    if (names.size !== migrations.length) {
      return yield* new Migrator.MigrationError({
        kind: "Duplicates",
        message: "Found duplicate migrations",
      });
    }

    const recorded = yield* sql<{
      readonly migration_id: number;
      readonly name: string;
    }>`SELECT migration_id, name FROM ${sql(TABLE)}`.withoutTransform;
    const applied = new Set(recorded.map((row) => fullName(row.migration_id, row.name)));
    const pending = migrations
      .filter(([id, name]) => !applied.has(fullName(id, name)))
      .toSorted(([a, aName], [b, bName]) => a - b || (aName < bName ? -1 : aName > bName ? 1 : 0));
    // Every pending migration loads before any runs, as with Migrator.
    const loaded = yield* Effect.forEach(pending, (migration) =>
      Effect.map(load(migration), (effect) => [migration[0], migration[1], effect] as const),
    );

    const completed: Array<readonly [id: number, name: string]> = [];
    for (const [id, name, effect] of loaded) {
      const ran = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO ${sql(TABLE)} (migration_id, name) VALUES (${id}, ${name})`.withoutTransform.pipe(
              Effect.mapError((error): Migrator.MigrationError | SqlError =>
                isConstraintConflict(error)
                  ? new Migrator.MigrationError({
                      kind: "Locked",
                      message: "Migrations already running",
                    })
                  : error,
              ),
            );
            yield* Effect.logDebug("Running migration");
            yield* Effect.catch(effect, (cause) =>
              Effect.die(
                new Migrator.MigrationError({
                  cause,
                  kind: "Failed",
                  message: `Migration "${fullName(id, name)}" failed`,
                }),
              ),
            );
          }),
        )
        .pipe(
          Effect.as(true),
          // Another run recorded it first; it runs the rest too.
          Effect.catchTags({
            MigrationError: (error) =>
              error.kind === "Locked"
                ? Effect.as(Effect.logDebug(error.message), false)
                : Effect.fail(error),
          }),
          Effect.annotateLogs("migration_id", String(id)),
          Effect.annotateLogs("migration_name", name),
          Effect.withSpan(`Migrator ${fullName(id, name)}`),
        );
      if (!ran) break;
      completed.push([id, name]);
    }
    return completed;
  });
