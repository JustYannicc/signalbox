import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import type { DriveRef, RecipeHash } from "../../src/computer/Computer.ts";
import type { FacetStorage } from "../../src/kernel/FacetSqliteStorage.ts";
import type { ProofBaseSource } from "./Bases.ts";
import { createDurableProofBases } from "./DurableBases.ts";
import { sqliteFixture } from "./ProofSqliteFixture.ts";

const drive = "proof-drive" as DriveRef;
const recipeHash = "proof-recipe" as RecipeHash;
const source = (verifyHeldSource = async () => {}): ProofBaseSource => ({
  drive,
  recipeHash,
  sourceRef: "run-owned-source",
  verifyHeldSource,
  now: () => 1_900_000_000_000,
  nextLeaseId: () => "lease-1",
});
const acquire = (proof: ReturnType<typeof createDurableProofBases>) =>
  Effect.map(proof.bases.acquire(drive, recipeHash), (lease) => {
    if (Option.isNone(lease)) throw new Error("Missing proof lease");
    return { ...lease.value };
  });
const rejects = <A>(effect: Effect.Effect<A>, message: string) =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(effect);
    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain(message);
  });

describe("durable proof Base leases", () => {
  it.effect("reconstructs journal-owned leases and released tombstones without old owners", () =>
    Effect.gen(function* () {
      const sql = sqliteFixture();
      try {
        let verifications = 0;
        const prepared = source(async () => {
          verifications++;
        });
        const lease = yield* acquire(createDurableProofBases(sql.storage, prepared));
        const journalCopy = { ...lease };
        const replacement = createDurableProofBases(sql.storage, prepared);
        expect(replacement.inspect()).toEqual({ acquired: 1, released: 0, held: 1 });
        yield* replacement.bases.release(journalCopy);
        const third = createDurableProofBases(sql.storage, prepared);
        yield* third.bases.release({ ...journalCopy });
        expect(third.inspect()).toEqual({ acquired: 1, released: 1, held: 0 });
        expect(verifications).toBe(2);
        yield* rejects(acquire(third), "Duplicate proof Base lease");
        yield* rejects(third.bases.release({ ...lease, sourceRef: "forged" }), "does not belong");
      } finally {
        sql.close();
      }
    }),
  );

  it.effect("rejects wrong source, unknown and altered leases while retaining held rows", () =>
    Effect.gen(function* () {
      const sql = sqliteFixture();
      try {
        const prepared = source();
        const lease = yield* acquire(createDurableProofBases(sql.storage, prepared));
        const replacement = createDurableProofBases(sql.storage, prepared);
        for (const forged of [
          { ...lease, id: "unknown" },
          { ...lease, expiresAt: 0 },
          { ...lease, sourceRef: "wrong" },
        ])
          yield* rejects(replacement.bases.release(forged), "does not belong");
        const wrongOwner = createDurableProofBases(sql.storage, {
          ...prepared,
          sourceRef: "another-vm",
        });
        yield* rejects(wrongOwner.bases.release(lease), "does not belong");
        const wrongDrive = createDurableProofBases(sql.storage, {
          ...prepared,
          drive: "other" as DriveRef,
        });
        yield* rejects(wrongDrive.bases.release(lease), "does not belong");
        expect(replacement.inspect()).toEqual({ acquired: 1, released: 0, held: 1 });
      } finally {
        sql.close();
      }
    }),
  );

  it.effect(
    "checks provider retention before acquisition and release and rolls back failed writes",
    () =>
      Effect.gen(function* () {
        const sql = sqliteFixture();
        try {
          let held = false;
          let failWrite = false;
          const storage: FacetStorage = {
            ...sql.storage,
            sql: {
              ...sql.storage.sql,
              exec(query, ...bindings) {
                const result = Array.from(sql.storage.sql.exec(query, ...bindings));
                if (failWrite && /^(INSERT|UPDATE)/.test(query))
                  throw new Error("injected transaction failure");
                return result;
              },
            },
          };
          const prepared = source(async () => {
            if (!held) throw new Error("source missing");
          });
          const proof = createDurableProofBases(storage, prepared);
          expect(Option.isNone(yield* proof.bases.acquire("other" as DriveRef, recipeHash))).toBe(
            true,
          );
          yield* rejects(acquire(proof), "source missing");
          expect(proof.inspect().held).toBe(0);
          held = true;
          failWrite = true;
          yield* rejects(acquire(proof), "transaction failure");
          failWrite = false;
          expect(proof.inspect().held).toBe(0);
          const lease = yield* acquire(proof);
          held = false;
          yield* rejects(proof.bases.release(lease), "source missing");
          held = true;
          failWrite = true;
          yield* rejects(proof.bases.release(lease), "transaction failure");
          failWrite = false;
          expect(createDurableProofBases(sql.storage, prepared).inspect()).toEqual({
            acquired: 1,
            released: 0,
            held: 1,
          });
          yield* proof.bases.release(lease);
          expect(proof.inspect().held).toBe(0);
        } finally {
          sql.close();
        }
      }),
  );
});
