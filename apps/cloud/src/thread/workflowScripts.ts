import { RetainedWorkflowScript } from "@signalbox/runner-protocol/RunnerProtocol";
import type { NodeId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export const migrateWorkflowScripts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE workflow_scripts (
    subagent_id TEXT NOT NULL,
    revision TEXT NOT NULL,
    record TEXT NOT NULL,
    PRIMARY KEY (subagent_id, revision)
  )`;
});

const record = Schema.fromJsonString(RetainedWorkflowScript);
const encode = Schema.encodeSync(record);
const decodeRows = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ record })));

export const readWorkflowScript = (subagentId: NodeId, revision: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql`SELECT record FROM workflow_scripts
      WHERE subagent_id = ${subagentId} AND revision = ${revision}`;
    return decodeRows(rows)[0]?.record ?? null;
  });

/** A retry or a later path reuse cannot replace the revision the workflow retained. */
export const retainWorkflowScripts = (scripts: ReadonlyArray<RetainedWorkflowScript>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const script of scripts) {
      yield* sql`INSERT INTO workflow_scripts (subagent_id, revision, record)
        VALUES (${script.subagentId}, ${script.revision}, ${encode(script)})
        ON CONFLICT DO NOTHING`;
    }
  });
