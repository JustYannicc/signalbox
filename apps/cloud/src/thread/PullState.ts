import { PullOperation, PullResult } from "@signalbox/runner-protocol/PullProtocol";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

export const migratePulls = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE thread_git_pulls (
    id TEXT PRIMARY KEY,
    actor_id TEXT NOT NULL,
    drive_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    generation INTEGER,
    phase TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    retry_at INTEGER,
    retry_generation INTEGER,
    retry_sequence INTEGER,
    result TEXT
  )`;
  yield* sql`CREATE UNIQUE INDEX thread_git_pull_pending
    ON thread_git_pulls ((1)) WHERE phase <> 'completed'`;
  yield* sql`CREATE TABLE thread_git_publication (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    id TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    drive_id TEXT NOT NULL,
    until_ms INTEGER NOT NULL
  )`;
});

const OperationJson = Schema.fromJsonString(PullOperation);
const ResultJson = Schema.fromJsonString(PullResult);
const Row = Schema.Struct({
  id: Schema.String,
  actor_id: Schema.String,
  drive_id: Schema.String,
  operation: OperationJson,
  generation: Schema.NullOr(Schema.Number),
  attempts: Schema.Number,
  retry_at: Schema.NullOr(Schema.Number),
  phase: Schema.Literals(["selected", "running", "completed"]),
  result: Schema.NullOr(ResultJson),
});
const rows = Schema.decodeUnknownSync(Schema.Array(Row));
const encodeOperation = Schema.encodeSync(OperationJson);
const encodeResult = Schema.encodeSync(ResultJson);
export type StoredPull = typeof Row.Type;

/** The runner reports outcomes without depending on thread admission or its engine. */
export class PullReports extends Context.Service<
  PullReports,
  {
    readonly reported: (generation: number, result: PullResult) => Effect.Effect<void>;
    readonly revoke: (id: string) => Effect.Effect<void>;
  }
>()("@signalbox/cloud/thread/PullReports") {}

const pullById = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return rows(yield* sql`SELECT * FROM thread_git_pulls WHERE id = ${id}`)[0] ?? null;
  });

const pendingPull = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return (
    rows(yield* sql`SELECT * FROM thread_git_pulls WHERE phase <> 'completed' LIMIT 1`)[0] ?? null
  );
});

const insertPull = (input: {
  readonly actorId: string;
  readonly driveId: string;
  readonly operation: PullOperation;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO thread_git_pulls (id, actor_id, drive_id, operation, phase)
      VALUES (${input.operation.id}, ${input.actorId}, ${input.driveId},
        ${encodeOperation(input.operation)}, 'selected')`;
  });

const assignPull = (id: string, generation: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE thread_git_pulls SET generation = ${generation}, phase = 'running', retry_at = NULL
      WHERE id = ${id} AND phase <> 'completed'`;
  });

const finishPull = (result: PullResult) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE thread_git_pulls SET result = ${encodeResult(result)}, phase = 'completed'
      WHERE id = ${result.id} AND phase <> 'completed'`;
  });

const retryPull = (id: string, generation: number, sequence: number, at: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE thread_git_pulls SET phase = 'selected', attempts = attempts + 1, retry_at = ${at},
      retry_generation = ${generation}, retry_sequence = ${sequence}
    WHERE id = ${id} AND phase <> 'completed'
      AND (retry_generation IS NULL OR retry_generation <> ${generation} OR retry_sequence < ${sequence})`;
  });

const Publication = Schema.Struct({
  id: Schema.String,
  actor_id: Schema.String,
  drive_id: Schema.String,
  until_ms: Schema.Number,
});
const publicationRows = Schema.decodeUnknownSync(Schema.Array(Publication));
const publication = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return (
    publicationRows(yield* sql`SELECT * FROM thread_git_publication WHERE singleton = 1`)[0] ?? null
  );
});
const reservePublication = (id: string, actorId: string, driveId: string, until: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT OR REPLACE INTO thread_git_publication (singleton, id, actor_id, drive_id, until_ms)
    VALUES (1, ${id}, ${actorId}, ${driveId}, ${until})`;
  });
const releasePublication = (id: string, actorId: string, driveId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM thread_git_publication
    WHERE singleton = 1 AND id = ${id} AND actor_id = ${actorId} AND drive_id = ${driveId}`;
  });

export class PullState extends Context.Service<
  PullState,
  {
    readonly byId: (id: string) => Effect.Effect<StoredPull | null, SqlError>;
    readonly pending: Effect.Effect<StoredPull | null, SqlError>;
    readonly insert: (input: Parameters<typeof insertPull>[0]) => Effect.Effect<void, SqlError>;
    readonly assign: (id: string, generation: number) => Effect.Effect<void, SqlError>;
    readonly retry: (
      id: string,
      generation: number,
      sequence: number,
      at: number,
    ) => Effect.Effect<void, SqlError>;
    readonly finish: (result: PullResult) => Effect.Effect<void, SqlError>;
    readonly publication: Effect.Effect<typeof Publication.Type | null, SqlError>;
    readonly reservePublication: (
      id: string,
      actorId: string,
      driveId: string,
      until: number,
    ) => Effect.Effect<void, SqlError>;
    readonly releasePublication: (
      id: string,
      actorId: string,
      driveId: string,
    ) => Effect.Effect<void, SqlError>;
  }
>()("@signalbox/cloud/thread/PullState") {}

export const layer = Layer.effect(
  PullState,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const run = Effect.provideService(SqlClient.SqlClient, sql);
    return PullState.of({
      byId: (id) => run(pullById(id)),
      pending: run(pendingPull),
      insert: (input) => run(insertPull(input)),
      assign: (id, generation) => run(assignPull(id, generation)),
      finish: (result) => run(finishPull(result)),
      retry: (id, generation, sequence, at) => run(retryPull(id, generation, sequence, at)),
      publication: run(publication),
      reservePublication: (id, actorId, driveId, until) =>
        run(reservePublication(id, actorId, driveId, until)),
      releasePublication: (id, actorId, driveId) => run(releasePublication(id, actorId, driveId)),
    });
  }),
);
