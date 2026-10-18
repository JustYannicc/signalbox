import { CheckpointId, CheckpointScopeId, CommandId, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export const RollbackOperation = Schema.Struct({
  version: Schema.Literal(1),
  commandId: CommandId,
  threadId: ThreadId,
  userId: Schema.String,
  driveId: Schema.NullOr(Schema.String),
  restoreFiles: Schema.Boolean,
  scopeId: CheckpointScopeId,
  checkpointId: CheckpointId,
  runId: RunId,
  targetOrdinal: Schema.Number,
  boundary: Schema.Literals(["start", "end"]),
  expectedThread: Schema.NullOr(Schema.String),
  expectedWip: Schema.NullOr(Schema.String),
  generation: Schema.Number,
  failure: Schema.optional(
    Schema.Struct({ category: Schema.Literals(["conflict", "refused"]), message: Schema.String }),
  ),
  stage: Schema.Literals([
    "prepared",
    "files-restored",
    "conversation-updated",
    "completed",
    "failed",
  ]),
});
export type RollbackOperation = typeof RollbackOperation.Type;

export const migrateRollback = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE thread_rollbacks (
    command_id TEXT PRIMARY KEY,
    stage TEXT NOT NULL,
    operation TEXT NOT NULL
  )`;
});

const Json = Schema.fromJsonString(RollbackOperation);
const encode = Schema.encodeSync(Json);
const decodeRows = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ operation: Json })));

export const pendingRollback = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows =
    yield* sql`SELECT operation FROM thread_rollbacks WHERE stage NOT IN ('completed', 'failed')`;
  return decodeRows(rows)[0]?.operation ?? null;
});

export const saveRollback = (operation: RollbackOperation) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO thread_rollbacks (command_id, stage, operation)
      VALUES (${operation.commandId}, ${operation.stage}, ${encode(operation)})
      ON CONFLICT (command_id) DO UPDATE SET stage = excluded.stage, operation = excluded.operation`;
  });
