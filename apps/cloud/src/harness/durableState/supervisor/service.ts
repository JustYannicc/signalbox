import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HarnessThreadSupervisorCommand } from "./contracts.ts";
import { HarnessThreadSupervisorError, fail } from "./errors.ts";
import { requireOwnSchema, formatTable, stateTable } from "./sqlite.ts";
import { decodeState, encodeState } from "./state.ts";
import type { HarnessThreadSupervisor, HarnessThreadSupervisorDatabase } from "./types.ts";
import type { HarnessThreadSupervisorCommand as HarnessThreadSupervisorCommandType } from "./contracts.ts";
import { result, transition } from "./transition.ts";

const first = (rows: Iterable<Record<string, unknown>>) => rows[Symbol.iterator]().next().value;
const decodeCommand = Schema.decodeUnknownSync(HarnessThreadSupervisorCommand, {
  onExcessProperty: "error",
});

export function createHarnessThreadSupervisor(
  database: HarnessThreadSupervisorDatabase,
  runId: string,
): HarnessThreadSupervisor {
  return {
    execute: (input) =>
      Effect.try({
        try: () => {
          let command: HarnessThreadSupervisorCommandType;
          try {
            command = decodeCommand(input);
          } catch (error) {
            if (error instanceof HarnessThreadSupervisorError) throw error;
            return fail("INVALID");
          }
          if (command.runId !== runId) return fail("CONFLICT");
          return database.transactionSync(() => {
            const pristine = requireOwnSchema(database, command.type === "initialize");
            const row = first(
              database.sql.exec(`SELECT revision, state_json FROM ${stateTable} WHERE slot = 1`),
            );
            const format = first(
              database.sql.exec(`SELECT version FROM ${formatTable} WHERE slot = 1`),
            );
            if ((!pristine && (!row || !format)) || (format && format.version !== 1))
              return fail("CORRUPT");
            if (
              row &&
              (typeof row.revision !== "number" ||
                !Number.isSafeInteger(row.revision) ||
                row.revision < 1 ||
                row.revision >= Number.MAX_SAFE_INTEGER)
            )
              return fail("CORRUPT");
            let current = null;
            if (row) {
              try {
                current = decodeState(row.state_json, runId);
              } catch (error) {
                if (error instanceof HarnessThreadSupervisorError) throw error;
                throw new HarnessThreadSupervisorError("CORRUPT", { cause: error });
              }
            }
            const next = transition(current, command);
            const encoded = encodeState(next.state);
            const checked = decodeState(encoded, runId);
            if (current !== next.state) {
              if (!row) {
                database.sql.exec(`INSERT INTO ${formatTable} (slot, version) VALUES (1, 1)`);
                database.sql.exec(
                  `INSERT INTO ${stateTable} (slot, revision, state_json) VALUES (1, 1, ?)`,
                  encoded,
                );
              } else {
                const updated = first(
                  database.sql.exec(
                    `UPDATE ${stateTable} SET revision = revision + 1, state_json = ? WHERE slot = 1 AND revision = ? RETURNING revision`,
                    encoded,
                    row.revision,
                  ),
                );
                if (!updated) return fail("STORAGE");
              }
            }
            return result(checked, next.action, next.revealPreparedPublisher);
          });
        },
        catch: (error) =>
          error instanceof HarnessThreadSupervisorError
            ? error
            : new HarnessThreadSupervisorError("STORAGE", { cause: error }),
      }),
  };
}
