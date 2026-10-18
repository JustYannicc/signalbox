import { GitPreparePullRequestThreadResult, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const Selection = Schema.Struct({
  projectId: ProjectId,
  driveId: Schema.String,
  threadId: ThreadId,
  repository: Schema.String,
  host: Schema.String,
  accountId: Schema.String,
  headSha: Schema.String,
  pullRequest: GitPreparePullRequestThreadResult.fields.pullRequest,
});
export type PullRequestThreadSelection = typeof Selection.Type;
const SelectionJson = Schema.fromJsonString(Selection);
const encodeSelection = Schema.encodeSync(SelectionJson);
const decodeRows = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      request_key: Schema.String,
      selection: SelectionJson,
      launch_started: Schema.Number,
      completed: Schema.Number,
    }),
  ),
);

/** The selected head and destination survive a partial drive reservation or thread launch. */
export const makePullRequestThreadReservations = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS pull_request_thread_preparations (
    operation_id TEXT PRIMARY KEY,
    request_key TEXT NOT NULL,
    selection TEXT NOT NULL,
    launch_started INTEGER NOT NULL DEFAULT 0,
    completed INTEGER NOT NULL DEFAULT 0
  )`;
  const read = (operationId: string) =>
    sql`SELECT request_key, selection, launch_started, completed FROM pull_request_thread_preparations
      WHERE operation_id = ${operationId}`.pipe(Effect.map((rows) => decodeRows(rows)[0] ?? null));

  const reserve = (
    operationId: string,
    requestKey: string,
    selection: PullRequestThreadSelection,
  ) =>
    sql`INSERT INTO pull_request_thread_preparations (operation_id, request_key, selection)
      VALUES (${operationId}, ${requestKey}, ${encodeSelection(selection)})
      ON CONFLICT (operation_id) DO NOTHING`.pipe(Effect.andThen(read(operationId)));

  const complete = (operationId: string) =>
    sql`UPDATE pull_request_thread_preparations SET completed = 1
      WHERE operation_id = ${operationId}`.pipe(Effect.asVoid);

  const launching = (operationId: string) =>
    sql`UPDATE pull_request_thread_preparations SET launch_started = 1
      WHERE operation_id = ${operationId}`.pipe(Effect.asVoid);

  return { read, reserve, launching, complete };
});
