import * as Schema from "effect/Schema";

export const id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
export const capability = Schema.String.check(Schema.isMinLength(32), Schema.isMaxLength(128));
export const integer = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
export const positive = integer.check(Schema.isGreaterThan(0));
export const Artifact = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  bytes: integer,
});
export const Supervisor = Schema.Struct({
  supervisorKey: capability,
  epoch: positive,
  claimId: id,
});
export const Progress = Schema.Struct({ sequence: positive, kind: id, reference: Artifact });
