import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

/** Timestamps as automations store them: ISO strings. */

export const isoAt = (epochMilliseconds: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(epochMilliseconds));

export const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
