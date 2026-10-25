import * as Schema from "effect/Schema";
import type { FacetStorage } from "../../kernel/FacetSqliteStorage.ts";
import type { MachineCommandJournal, MachineCommandRecord } from "../MachineCommandJournal.ts";

const revision = Schema.Struct({
  repository: Schema.String,
  fork: Schema.String,
  commit: Schema.String,
});
const base = Schema.Struct({
  id: Schema.String,
  sourceRef: Schema.String,
  expiresAt: Schema.Number,
  retention: Schema.optionalKey(Schema.Literal("until-release")),
});
const createInput = Schema.Struct({
  operationId: Schema.String,
  drive: Schema.String,
  recipeHash: Schema.String,
  base: Schema.NullOr(base),
  expiresAt: Schema.Number,
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
  base: Schema.optionalKey(base),
  settled: Schema.optionalKey(
    Schema.Struct({
      operationId: Schema.String,
      machineId: Schema.String,
      generation: Schema.Number,
      closed: Schema.Literal(true),
    }),
  ),
  createInput: Schema.optionalKey(createInput),
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
const decode = (json: string): MachineCommandRecord =>
  decodeRecord(json) as unknown as MachineCommandRecord;
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

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
    const captured = decode(json);
    const createPhase = phases.indexOf("create");
    if (
      captured.phase !== "complete" &&
      phases.indexOf(captured.phase) >= createPhase &&
      (!captured.createInput || captured.createInput.operationId !== captured.operationId)
    ) {
      throw new Error("Machine create inputs must be journaled before machine work starts");
    }
    if (
      captured.createInput?.base &&
      (captured.base?.id !== captured.createInput.base.id ||
        captured.base.sourceRef !== captured.createInput.base.sourceRef ||
        captured.base.expiresAt !== captured.createInput.base.expiresAt ||
        captured.base.retention !== captured.createInput.base.retention)
    ) {
      throw new Error("Machine create Base does not match the journaled lease");
    }
    this.#storage.transactionSync(() => {
      const previous = Array.from(
        this.#storage.sql.exec(
          "SELECT record_json FROM computer_machine_command WHERE operation_id = ?",
          captured.operationId,
        ),
      )[0];
      if (previous) {
        const old = decode(String(previous.record_json));
        if (
          old.phase === "complete" ||
          phases.indexOf(captured.phase) < phases.indexOf(old.phase)
        ) {
          throw new Error("Machine command identity was reused or its phase moved backwards");
        }
        for (const field of [
          "createInput",
          "before",
          "after",
          "base",
          "machine",
          "settled",
        ] as const) {
          if (old[field] !== undefined && !same(old[field], captured[field])) {
            throw new Error(`Machine command ${field} changed after it was journaled`);
          }
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

  read(operationId: string): MachineCommandRecord | undefined {
    const row = Array.from(
      this.#storage.sql.exec(
        "SELECT record_json FROM computer_machine_command WHERE operation_id = ?",
        operationId,
      ),
    )[0];
    return row ? decode(String(row.record_json)) : undefined;
  }

  pending(): readonly MachineCommandRecord[] {
    return Array.from(
      this.#storage.sql.exec(
        "SELECT record_json FROM computer_machine_command WHERE phase <> 'complete' ORDER BY operation_id",
      ),
      (row) => decode(String(row.record_json)),
    );
  }
}
