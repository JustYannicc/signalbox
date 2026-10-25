import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import type { DriveRef, RecipeHash } from "../../src/computer/Computer.ts";
import { createProofBases } from "./Bases.ts";

const drive = "drive:proof" as DriveRef;
const otherDrive = "drive:other" as DriveRef;
const recipeHash = "proof-recipe" as RecipeHash;

describe("proof Base leases", () => {
  it.effect("matches the exact drive and recipe and verifies a retained source", () =>
    Effect.gen(function* () {
      let verifications = 0;
      let ids = 0;
      const now = 1_900_000_000_000;
      const proof = createProofBases({
        sourceRef: "boxd-source",
        drive,
        recipeHash,
        verifyHeldSource: async () => {
          verifications += 1;
        },
        now: () => now,
        nextLeaseId: () => `proof-lease-${++ids}`,
      });

      const wrongDrive = yield* proof.bases.acquire(otherDrive, recipeHash);
      const wrongRecipe = yield* proof.bases.acquire(drive, "other-recipe" as RecipeHash);
      expect(Option.isNone(wrongDrive)).toBe(true);
      expect(Option.isNone(wrongRecipe)).toBe(true);
      expect(verifications).toBe(0);
      expect(proof.inspect()).toEqual({ acquired: 0, released: 0, held: 0 });

      const acquired = yield* proof.bases.acquire(drive, recipeHash);
      expect(Option.isSome(acquired)).toBe(true);
      if (Option.isNone(acquired)) throw new Error("Matching proof Base was not acquired");
      expect(acquired.value).toEqual({
        id: "proof-lease-1",
        sourceRef: "boxd-source",
        expiresAt: now + 600_000,
        retention: "until-release",
      });
      expect(verifications).toBe(1);
      expect(proof.inspect()).toEqual({ acquired: 1, released: 0, held: 1 });
    }),
  );

  it.effect(
    "requires the exact lease and verifies the source again before idempotent release",
    () =>
      Effect.gen(function* () {
        let sourceHeld = true;
        let verifications = 0;
        const proof = createProofBases({
          sourceRef: "boxd-source",
          drive,
          recipeHash,
          verifyHeldSource: async () => {
            verifications += 1;
            if (!sourceHeld) throw new Error("source is no longer held");
          },
          now: () => 1_900_000_000_000,
          nextLeaseId: () => "proof-lease-1",
        });
        const acquired = yield* proof.bases.acquire(drive, recipeHash);
        if (Option.isNone(acquired)) throw new Error("Matching proof Base was not acquired");
        const lease = acquired.value;

        const wrongLease = yield* Effect.exit(
          proof.bases.release({ ...lease, sourceRef: "other-source" }),
        );
        expect(Exit.isFailure(wrongLease)).toBe(true);
        if (Exit.isFailure(wrongLease)) {
          expect(Cause.pretty(wrongLease.cause)).toContain(
            "Proof Base lease does not belong to this source",
          );
        }
        expect(proof.inspect()).toEqual({ acquired: 1, released: 0, held: 1 });

        sourceHeld = false;
        const missingSource = yield* Effect.exit(proof.bases.release(lease));
        expect(Exit.isFailure(missingSource)).toBe(true);
        if (Exit.isFailure(missingSource)) {
          expect(Cause.pretty(missingSource.cause)).toContain("source is no longer held");
        }
        expect(proof.inspect()).toEqual({ acquired: 1, released: 0, held: 1 });

        sourceHeld = true;
        yield* proof.bases.release(lease);
        yield* proof.bases.release(lease);

        expect(verifications).toBe(3);
        expect(proof.inspect()).toEqual({ acquired: 1, released: 1, held: 0 });
      }),
  );
});
