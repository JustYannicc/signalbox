import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { Oid } from "../git/gitObjects.ts";

export class DriveHydrationError extends Schema.TaggedError<DriveHydrationError>()(
  "DriveHydrationError",
  {
    oid: Schema.String,
    reason: Schema.Literals([
      "source",
      "header",
      "checkpoint",
      "dependency",
      "range",
      "inflate",
      "delta",
      "hash",
      "state",
    ]),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message() {
    return "The drive's metadata could not be hydrated.";
  }
}

export class HydrationRemoteError extends Schema.TaggedError<HydrationRemoteError>()(
  "HydrationRemoteError",
  { oid: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return "The remote metadata range could not be read.";
  }
}

const isHydrationError = Schema.is(DriveHydrationError);
export const failure = (oid: Oid, reason: DriveHydrationError["reason"], cause?: unknown) =>
  isHydrationError(cause)
    ? cause
    : new DriveHydrationError({ oid, reason, ...(cause === undefined ? {} : { cause }) });
export const at = <A, E>(
  oid: Oid,
  reason: DriveHydrationError["reason"],
  effect: Effect.Effect<A, E>,
) => effect.pipe(Effect.mapError((cause) => failure(oid, reason, cause)));
