import * as Schema from "effect/Schema";
import type { FacetStorage } from "../../kernel/FacetSqliteStorage.ts";
import type { MachineCommandJournal, MachineCommandRecord } from "../MachineCommandJournal.ts";

const revision = Schema.Struct({
  repository: Schema.String,
  fork: Schema.String,
  commit: Schema.String,
});
const recordSchema = Schema.Struct({
  operationId: Schema.String,
  phase: Schema.Literals([
    "checkpoint",
    "create",
    "prepare",
    "execute",
    "commit",
    "apply",
    "delete",
    "complete",
  ]),
  before: Schema.optionalKey(revision),
  after: Schema.optionalKey(revision),
  machine: Schema.optionalKey(Schema.Struct({ id: Schema.String, generation: Schema.Number })),
  base: Schema.optionalKey(
    Schema.Struct({ id: Schema.String, sourceRef: Schema.String, expiresAt: Schema.Number }),
  ),
});
const decodeRecord = Schema.decodeUnknownSync(Schema.fromJsonString(recordSchema));
const phases = [
  "checkpoint",
  "create",
  "prepare",
  "execute",
  "commit",
  "apply",
  "delete",
  "complete",
];

/** Retains interrupted operations for reconciliation; opening a journal never replays a command. */
export class SqliteMachineCommandJournal implements MachineCommandJournal {
  readonly #storage: FacetStorage;

  constructor(storage: FacetStorage) {
    this.#storage = storage;
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS computer_machine_command (operation_id TEXT PRIMARY KEY, phase TEXT NOT NULL, record_json TEXT NOT NULL)",
    );
  }

  async write(record: MachineCommandRecord) {
    const json = JSON.stringify(record);
    const captured = decodeRecord(json);
    this.#storage.transactionSync(() => {
      const previous = Array.from(
        this.#storage.sql.exec(
          "SELECT record_json FROM computer_machine_command WHERE operation_id = ?",
          captured.operationId,
        ),
      )[0];
      if (previous) {
        const old = decodeRecord(String(previous.record_json));
        if (
          captured.phase === "checkpoint" ||
          old.phase === "complete" ||
          phases.indexOf(captured.phase) < phases.indexOf(old.phase)
        ) {
          throw new Error("Machine command identity was reused or its phase moved backwards");
        }
      } else if (captured.phase !== "checkpoint") {
        throw new Error("Machine command must be recorded before external work starts");
      }
      this.#storage.sql.exec(
        "INSERT INTO computer_machine_command VALUES (?, ?, ?) ON CONFLICT(operation_id) DO UPDATE SET phase=excluded.phase, record_json=excluded.record_json",
        captured.operationId,
        captured.phase,
        json,
      );
    });
  }

  pending(): readonly MachineCommandRecord[] {
    return Array.from(
      this.#storage.sql.exec(
        "SELECT record_json FROM computer_machine_command WHERE phase <> 'complete' ORDER BY operation_id",
      ),
      (row) => decodeRecord(String(row.record_json)),
    );
  }
}
