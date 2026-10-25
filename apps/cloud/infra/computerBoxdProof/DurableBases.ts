import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { BaseLease, Bases } from "../../src/computer/Computer.ts";
import type { FacetStorage } from "../../src/kernel/FacetSqliteStorage.ts";
import type { ProofBaseSource } from "./Bases.ts";

/** Durable proof leases over one run-owned prepared VM, not a production Base pool. */
export function createDurableProofBases(storage: FacetStorage, source: ProofBaseSource) {
  const exec = (query: string, ...bindings: (string | number)[]) =>
    Array.from(storage.sql.exec(query, ...bindings));
  exec(
    "CREATE TABLE IF NOT EXISTS proof_base_lease (id TEXT PRIMARY KEY, source_ref TEXT NOT NULL, drive TEXT NOT NULL, recipe TEXT NOT NULL, expires_at INTEGER NOT NULL, retention TEXT NOT NULL, released INTEGER NOT NULL DEFAULT 0)",
  );
  const owned = (lease: BaseLease) => {
    const row = exec("SELECT * FROM proof_base_lease WHERE id = ?", lease.id)[0];
    if (
      !row ||
      row.source_ref !== source.sourceRef ||
      row.drive !== source.drive ||
      row.recipe !== source.recipeHash ||
      row.source_ref !== lease.sourceRef ||
      row.expires_at !== lease.expiresAt ||
      row.retention !== lease.retention ||
      lease.retention !== "until-release"
    )
      throw new Error("Proof Base lease does not belong to this source");
    return row;
  };
  const bases: Bases = {
    acquire: (drive, recipeHash) =>
      Effect.promise(async () => {
        if (drive !== source.drive || recipeHash !== source.recipeHash) return Option.none();
        await source.verifyHeldSource();
        return storage.transactionSync(() => {
          const id = source.nextLeaseId();
          const expiresAt = source.now() + 600_000;
          if (!id || !source.sourceRef || !Number.isSafeInteger(expiresAt))
            throw new Error("Invalid proof Base lease");
          if (exec("SELECT id FROM proof_base_lease WHERE id = ?", id).length)
            throw new Error("Duplicate proof Base lease");
          exec(
            "INSERT INTO proof_base_lease (id, source_ref, drive, recipe, expires_at, retention) VALUES (?, ?, ?, ?, ?, ?)",
            id,
            source.sourceRef,
            drive,
            recipeHash,
            expiresAt,
            "until-release",
          );
          return Option.some(
            Object.freeze({
              id,
              sourceRef: source.sourceRef,
              expiresAt,
              retention: "until-release" as const,
            }),
          );
        });
      }),
    release: (lease) =>
      Effect.promise(async () => {
        const row = storage.transactionSync(() => owned(lease));
        if (row.released === 1) return;
        await source.verifyHeldSource();
        storage.transactionSync(() => {
          owned(lease);
          exec("UPDATE proof_base_lease SET released = 1 WHERE id = ?", lease.id);
        });
      }),
  };
  return {
    bases,
    inspect: () =>
      storage.transactionSync(() => {
        const rows = exec(
          "SELECT released FROM proof_base_lease WHERE source_ref = ? AND drive = ? AND recipe = ?",
          source.sourceRef,
          source.drive,
          source.recipeHash,
        );
        const released = rows.filter((row) => row.released === 1).length;
        return { acquired: rows.length, released, held: rows.length - released };
      }),
  };
}
