import * as Effect from "effect/Effect";
import type { Bases } from "../Computer.ts";

/** Keeps Computer usable until a drive has a prepared Base. */
export const NoneBases: Bases = {
  acquire: () => Effect.succeedNone,
  release: () => Effect.void,
};
