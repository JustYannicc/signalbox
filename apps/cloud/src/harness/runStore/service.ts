import * as Effect from "effect/Effect";
import type { HarnessRunDatabase, HarnessRunStore } from "./types.ts";
import { decodeCommand, decodeState, encodeState, snapshot } from "./records.ts";
import { fail, HarnessRunStoreError } from "./errors.ts";
import { transition } from "./transition.ts";
import { versions } from "./format.ts";
import { formatTable, requireOwnSchema, stateTable } from "./sqliteSchema.ts";

const first = (rows: Iterable<Record<string, unknown>>) => rows[Symbol.iterator]().next().value;

/** The binding supplies the object name, never a caller-selected alternate database. */
export function createHarnessRunStore(
  database: HarnessRunDatabase,
  runId: string,
): HarnessRunStore {
  return {
    execute: (input) =>
      Effect.try({
        try: () => {
          const command = decodeCommand(input);
          if (
            (command.type === "initialize" ? command.seed.identity.runId : command.runId) !== runId
          )
            return fail("CONFLICT");
          return database.transactionSync(() => {
            const pristine = requireOwnSchema(database, command.type === "initialize");
            const row = first(
              database.sql.exec(`SELECT revision, state_json FROM ${stateTable} WHERE slot = 1`),
            );
            const format = first(
              database.sql.exec(`SELECT version FROM ${formatTable} WHERE slot = 1`),
            );
            if (
              (!pristine && (!row || !format)) ||
              (format && !versions.some((version) => version === format.version))
            )
              return fail("CORRUPT");
            if (
              row &&
              (typeof row.revision !== "number" ||
                !Number.isSafeInteger(row.revision) ||
                row.revision < 1 ||
                row.revision >= Number.MAX_SAFE_INTEGER)
            )
              return fail("CORRUPT");
            const current = row ? decodeState(row.state_json, runId) : null;
            // The independent marker keeps lost request data from falling back to legacy launch authority.
            if (current && current.version !== format?.version) return fail("CORRUPT");
            const next = transition(current, command);
            const json = encodeState(next.state);
            // Validate cross-field invariants before any write, including our own transitions.
            const checked = decodeState(json, runId);
            if (current !== next.state) {
              if (!row) {
                database.sql.exec(
                  `INSERT INTO ${formatTable} (slot, version) VALUES (1, ?)`,
                  checked.version,
                );
                database.sql.exec(
                  `INSERT INTO ${stateTable} (slot, revision, state_json) VALUES (1, 1, ?)`,
                  json,
                );
              } else {
                const updated = first(
                  database.sql.exec(
                    `UPDATE ${stateTable} SET revision = revision + 1, state_json = ? WHERE slot = 1 AND revision = ? RETURNING revision`,
                    json,
                    row.revision,
                  ),
                );
                if (!updated) return fail("STORAGE");
                if (current?.version !== checked.version) {
                  database.sql.exec(
                    `UPDATE ${formatTable} SET version = ? WHERE slot = 1`,
                    checked.version,
                  );
                }
              }
            }
            return { action: next.action, snapshot: snapshot(checked) };
          });
        },
        catch: (error) =>
          error instanceof HarnessRunStoreError
            ? error
            : new HarnessRunStoreError("STORAGE", { cause: error }),
      }),
  };
}
