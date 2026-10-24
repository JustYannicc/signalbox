import * as Schema from "effect/Schema";

export const id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
export const capability = Schema.String.check(Schema.isMinLength(32), Schema.isMaxLength(128));
export const positive = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
export const digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));

export const HarnessThreadSupervisorControlClaim = Schema.Struct({
  ownerId: id,
  incarnationId: id,
  epoch: positive,
  controlKey: capability,
});

export const HarnessThreadSupervisorPublisher = Schema.Struct({
  generation: positive,
  facetNonce: id,
  publisherKey: capability,
});

const Authority = Schema.Struct({ ownerId: id, incarnationId: id, epoch: positive });
const Checkpoint = Schema.Struct({ checkpointId: id, manifestSha256: digest });
const AdmissionSource = Schema.Struct({
  authority: Authority,
  generation: positive,
  facetNonce: id,
  checkpoint: Checkpoint,
  admittedStepId: Schema.NullOr(id),
});

export const HarnessDurableStateAdmissionBinding = Schema.Struct({
  runId: id,
  evidenceId: id,
  authority: Authority,
  expectedGeneration: positive,
  outcome: Schema.Literals(["notApplied", "completed"]),
  checkpoint: Schema.NullOr(Checkpoint),
  source: AdmissionSource,
});

export type HarnessThreadSupervisorControlClaim = typeof HarnessThreadSupervisorControlClaim.Type;
export type HarnessThreadSupervisorPublisher = typeof HarnessThreadSupervisorPublisher.Type;
export type HarnessDurableStateAdmissionBinding = typeof HarnessDurableStateAdmissionBinding.Type;
