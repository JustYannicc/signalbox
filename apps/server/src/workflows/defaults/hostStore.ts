import { AutomationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import type { AutomationRow } from "../WorkflowStore.ts";

/**
 * Which automation row hosts a built-in in a project: `builtin_slug` on the
 * row. Saves never write the column, so a save keeps the mark and only
 * `mark` changes it.
 */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const run = <A>(operation: string, statement: Effect.Effect<A, SqlError>) =>
    statement.pipe(
      Effect.mapError(
        (cause) =>
          new AutomationError({ message: `Automation storage failed (${operation}).`, cause }),
      ),
    );
  return {
    /** The built-in's host row in a project, if it has one. */
    hostIn: (projectId: string, slug: string) =>
      run(
        "builtInHost",
        sql<AutomationRow>`
          SELECT * FROM signalbox_automations WHERE project_id = ${projectId} AND builtin_slug = ${slug}
        `,
      ).pipe(Effect.map((rows) => rows[0])),
    /** Marks a row as a built-in's host, or (null) turns it into an ordinary automation. */
    mark: (automationId: string, slug: string | null) =>
      run(
        "markBuiltIn",
        sql`UPDATE signalbox_automations SET builtin_slug = ${slug} WHERE automation_id = ${automationId}`,
      ),
  };
});

export type HostStore = Effect.Success<typeof make>;
