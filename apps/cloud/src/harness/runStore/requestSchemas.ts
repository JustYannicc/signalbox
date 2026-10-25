import * as Schema from "effect/Schema";
import { Artifact, capability, id, integer, positive, Progress, Supervisor } from "./values.ts";

const Checkpoint = Schema.Struct({ native: Artifact, filesystem: Artifact });
const Publisher = Schema.Struct({ generation: positive, facetNonce: id, publisherKey: capability });
const Offer = Schema.Struct({ requestId: id, input: Artifact });
const Finish = Schema.Struct({
  sequence: positive,
  status: Schema.Literals(["completed", "failed"]),
  result: Artifact,
  checkpoint: Checkpoint,
});
const Outcome = Schema.Union([
  Schema.Struct({ type: Schema.Literal("unknown") }),
  Schema.Struct({ type: Schema.Literal("not-applied") }),
  Schema.Struct({
    type: Schema.Literal("completed"),
    status: Finish.fields.status,
    result: Artifact,
    checkpoint: Checkpoint,
  }),
]);
const Reconciliation = Schema.Struct({ evidence: Artifact, outcome: Outcome });
const Run = { runId: id };
const Controlled = { ...Run, controlKey: capability };
const Published = { ...Run, publisher: Publisher, requestId: id };

export const RequestCommands = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("request.mode"),
    ...Controlled,
    requestId: id,
    checkpoint: Checkpoint,
  }),
  Schema.Struct({
    type: Schema.Literal("request.replaceFacet"),
    ...Controlled,
    expectedGeneration: integer,
    operationId: id,
    facetNonce: id,
    publisherKey: capability,
  }),
  Schema.Struct({
    type: Schema.Literal("request.offer"),
    ...Run,
    supervisor: Supervisor,
    request: Offer,
  }),
  Schema.Struct({ type: Schema.Literal("request.admit"), ...Published }),
  Schema.Struct({ type: Schema.Literal("request.check"), ...Published }),
  Schema.Struct({ type: Schema.Literal("request.progress"), ...Published, progress: Progress }),
  Schema.Struct({ type: Schema.Literal("request.finish"), ...Published, finish: Finish }),
  Schema.Struct({
    type: Schema.Literal("request.reconcile"),
    ...Controlled,
    requestId: id,
    ...Reconciliation.fields,
  }),
]);
export type RequestCommand = typeof RequestCommands.Type;

const Entry = Schema.Struct({
  request: Offer,
  generation: positive,
  facetNonce: id,
  status: Schema.Literals(["offered", "admitted", "indeterminate", "completed", "not-applied"]),
  progress: Schema.NullOr(Progress),
  finish: Schema.NullOr(Finish),
  reconciliation: Schema.NullOr(Reconciliation),
});
export const RequestMode = Schema.Struct({
  modeId: id,
  initialCheckpoint: Checkpoint,
  checkpoint: Checkpoint,
  facets: Schema.Array(
    Schema.Struct({
      generation: positive,
      operationId: id,
      facetNonce: id,
      publisherKey: capability,
      supervisorEpoch: positive,
      checkpoint: Checkpoint,
    }),
  ).check(Schema.isMaxLength(64)),
  entries: Schema.Array(Entry).check(Schema.isMaxLength(128)),
});
export type RequestMode = typeof RequestMode.Type;
export type HarnessRequestPublisher = typeof Publisher.Type;
export type HarnessRequestCheckpoint = typeof Checkpoint.Type;
export type HarnessRequestOffer = typeof Offer.Type;
export type HarnessRequestFinish = typeof Finish.Type;
export type HarnessRequestReconciliation = typeof Reconciliation.Type;
export type HarnessRunArtifact = HarnessRequestCheckpoint["native"];

export function requestSnapshot(mode: RequestMode) {
  return {
    ...mode,
    facets: mode.facets.map(
      ({ generation, operationId, facetNonce, supervisorEpoch, checkpoint }) => ({
        generation,
        operationId,
        facetNonce,
        supervisorEpoch,
        checkpoint,
      }),
    ),
  };
}
export type HarnessRequestSnapshot = ReturnType<typeof requestSnapshot>;
