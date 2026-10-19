import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { FacetStorage } from "../../kernel/FacetSqliteStorage.ts";
import type { Machine } from "../Machine.ts";
import type { BoxdMachineReservation, BoxdMachineReservations } from "./BoxdMachines.ts";

const reservationSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  generation: Schema.Number,
  createStarted: Schema.Boolean,
  machineId: Schema.NullOr(Schema.String),
});
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(reservationSchema));

/** Tombstones prevent an old operation from acquiring a fresh name after deletion. */
export class SqliteBoxdReservations implements BoxdMachineReservations {
  readonly #storage: FacetStorage;
  readonly #newId: () => string;

  constructor(storage: FacetStorage, newId: () => string) {
    this.#storage = storage;
    this.#newId = newId;
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS computer_boxd_reservation (operation_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, generation INTEGER UNIQUE NOT NULL, record_json TEXT NOT NULL, released INTEGER NOT NULL DEFAULT 0)",
    );
  }

  async reserve(input: Parameters<Machine["create"]>[0]): Promise<BoxdMachineReservation> {
    const fingerprint = JSON.stringify({
      drive: input.drive,
      recipeHash: input.recipeHash,
      expiresAt: input.expiresAt,
      base: Option.isSome(input.base)
        ? {
            id: input.base.value.id,
            sourceRef: input.base.value.sourceRef,
            expiresAt: input.base.value.expiresAt,
          }
        : null,
    });
    return this.#storage.transactionSync(() => {
      const previous = this.#read(input.operationId);
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new Error("Machine operation inputs changed");
        if (previous.released !== 0) throw new Error("Machine operation was already released");
        return decode(String(previous.record_json));
      }
      const id = this.#newId();
      if (!/^[a-z0-9-]{1,64}$/.test(id)) throw new Error("Invalid machine reservation identity");
      const row = Array.from(
        this.#storage.sql.exec(
          "SELECT COALESCE(MAX(generation), 0) + 1 AS next_generation FROM computer_boxd_reservation",
        ),
      )[0];
      const generation = Number(row?.next_generation);
      if (!Number.isSafeInteger(generation) || generation < 1)
        throw new Error("Machine generation exhausted");
      const reservation = {
        id,
        name: `computer-${id}`,
        generation,
        createStarted: false,
        machineId: null,
      };
      this.#storage.sql.exec(
        "INSERT INTO computer_boxd_reservation (operation_id, fingerprint, generation, record_json) VALUES (?, ?, ?, ?)",
        input.operationId,
        fingerprint,
        generation,
        JSON.stringify(reservation),
      );
      return reservation;
    });
  }

  async startCreate(reservation: BoxdMachineReservation): Promise<boolean> {
    return this.#update(reservation, (current) => {
      if (current.createStarted) return { record: current, result: false };
      return { record: { ...current, createStarted: true }, result: true };
    });
  }

  async recordMachineId(reservation: BoxdMachineReservation, machineId: string): Promise<void> {
    this.#update(reservation, (current) => {
      if (
        !machineId ||
        !current.createStarted ||
        (current.machineId !== null && current.machineId !== machineId)
      ) {
        throw new Error("Machine reservation provider identity changed");
      }
      return { record: { ...current, machineId }, result: undefined };
    });
  }

  async release(reservation: BoxdMachineReservation): Promise<void> {
    this.#storage.transactionSync(() => {
      const row = this.#owned(reservation);
      this.#storage.sql.exec(
        "UPDATE computer_boxd_reservation SET released = 1 WHERE operation_id = ?",
        String(row.operation_id),
      );
    });
  }

  #read(operationId: string) {
    return Array.from(
      this.#storage.sql.exec(
        "SELECT * FROM computer_boxd_reservation WHERE operation_id = ?",
        operationId,
      ),
    )[0];
  }

  #owned(reservation: BoxdMachineReservation) {
    const row = Array.from(
      this.#storage.sql.exec(
        "SELECT * FROM computer_boxd_reservation WHERE generation = ?",
        reservation.generation,
      ),
    )[0];
    if (!row) throw new Error("Machine reservation is missing");
    const current = decode(String(row.record_json));
    if (current.id !== reservation.id || current.name !== reservation.name)
      throw new Error("Machine reservation ownership changed");
    return row;
  }

  #update<T>(
    reservation: BoxdMachineReservation,
    change: (current: BoxdMachineReservation) => { record: BoxdMachineReservation; result: T },
  ): T {
    return this.#storage.transactionSync(() => {
      const row = this.#owned(reservation);
      if (row.released !== 0) throw new Error("Machine operation was already released");
      const changed = change(decode(String(row.record_json)));
      this.#storage.sql.exec(
        "UPDATE computer_boxd_reservation SET record_json = ? WHERE operation_id = ?",
        JSON.stringify(changed.record),
        String(row.operation_id),
      );
      return changed.result;
    });
  }
}
