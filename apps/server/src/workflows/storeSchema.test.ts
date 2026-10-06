import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ensureAutomationTables } from "./storeSchema.ts";

const AT = "2026-10-06T09:00:00.000Z";

const insertAutomation = (id: string, projectId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO signalbox_automations (
        automation_id, name, enabled, version, project_id, defaults_json, triggers_json,
        webhook_token, created_at, updated_at, draft_version, intent
      ) VALUES (
        ${id}, 'Weekly report', 0, 0, ${projectId}, '{}', '[]', ${`hook_${id}`},
        ${AT}, ${AT}, 1, 'Summarize the week'
      )`;
  });

it.effect("names are unique per project and a second run keeps every row", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* ensureAutomationTables;
    yield* insertAutomation("automation_a", "project-a");
    yield* insertAutomation("automation_b", "project-b");
    const duplicate = yield* insertAutomation("automation_dupe", "project-a").pipe(Effect.flip);
    expect(duplicate).toBeDefined();

    yield* ensureAutomationTables;
    expect(
      yield* sql<{
        automation_id: string;
        draft_version: number | null;
        intent: string | null;
      }>`SELECT automation_id, draft_version, intent FROM signalbox_automations ORDER BY automation_id`,
    ).toEqual([
      { automation_id: "automation_a", draft_version: 1, intent: "Summarize the week" },
      { automation_id: "automation_b", draft_version: 1, intent: "Summarize the week" },
    ]);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
