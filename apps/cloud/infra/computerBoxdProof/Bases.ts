import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { BaseLease, Bases, DriveRef, RecipeHash } from "../../src/computer/Computer.ts";

export interface ProofBaseSource {
  readonly sourceRef: string;
  readonly drive: DriveRef;
  readonly recipeHash: RecipeHash;
  readonly verifyHeldSource: () => Promise<void>;
  readonly now: () => number;
  readonly nextLeaseId: () => string;
}

/** Proof-only leases over one run-owned prepared VM. Production Bases remains separate. */
export function createProofBases(source: ProofBaseSource) {
  const leases = new Map<string, BaseLease>();
  const released = new Set<string>();
  let acquired = 0;
  let releases = 0;

  const bases: Bases = {
    acquire: (drive, recipeHash) =>
      Effect.promise(async () => {
        if (drive !== source.drive || recipeHash !== source.recipeHash) return Option.none();
        await source.verifyHeldSource();
        const id = source.nextLeaseId();
        if (!id || leases.has(id) || released.has(id))
          throw new Error("Duplicate proof Base lease");
        const lease: BaseLease = Object.freeze({
          id,
          sourceRef: source.sourceRef,
          expiresAt: source.now() + 600_000,
          retention: "until-release",
        });
        leases.set(id, lease);
        acquired++;
        return Option.some(lease);
      }),
    release: (lease) =>
      Effect.promise(async () => {
        if (released.has(lease.id)) return;
        const held = leases.get(lease.id);
        if (
          held === undefined ||
          held.sourceRef !== lease.sourceRef ||
          held.expiresAt !== lease.expiresAt ||
          lease.retention !== "until-release"
        ) {
          throw new Error("Proof Base lease does not belong to this source");
        }
        await source.verifyHeldSource();
        leases.delete(lease.id);
        released.add(lease.id);
        releases++;
      }),
  };
  return {
    bases,
    inspect: () => ({ acquired, released: releases, held: leases.size }),
  };
}
