import * as Effect from "effect/Effect";
import type { Bases, DriveRef, RecipeHash } from "../Computer.ts";

/** Runtime boundary between Computer's Promise host callbacks and the Bases Effect port. */
export function basesPromise(bases: Bases, drive: DriveRef, recipeHash: RecipeHash) {
  return {
    acquire: () => Effect.runPromise(bases.acquire(drive, recipeHash)),
    release: (lease: Parameters<Bases["release"]>[0]) => Effect.runPromise(bases.release(lease)),
  };
}
