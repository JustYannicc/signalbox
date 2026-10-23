import * as Schema from "effect/Schema";
import { capability, digest, id, positive } from "../shared.ts";
import { fail } from "./errors.ts";

const Control = Schema.Struct({
  ownerId: id,
  incarnationId: id,
  epoch: positive,
  controlKey: capability,
});
const Publisher = Schema.Struct({
  generation: positive,
  facetNonce: id,
  publisherKey: capability,
});
const Checkpoint = Schema.Struct({ checkpointId: id, manifestSha256: digest });
const Cleanup = Schema.Struct({
  stopAcknowledged: Schema.Boolean,
  invocationRpcJoined: Schema.Boolean,
  fetchJoined: Schema.Boolean,
  callbackPortsJoined: Schema.Boolean,
  disposed: Schema.Boolean,
});
const Failure = Schema.Struct({ kind: id, message: id });
const Settlement = Schema.Struct({
  outcome: Schema.Literals(["settled", "stopped", "indeterminate"]),
  invocationRpcJoined: Schema.Boolean,
  fetchJoined: Schema.Boolean,
  callbackPortsJoined: Schema.Boolean,
});
const LastFailure = Schema.Struct({
  phase: Schema.Literals(["prepare", "publish", "activate"]),
  operationId: id,
  failure: Failure,
  cleanup: Schema.NullOr(Cleanup),
});
const Prepared = Schema.Struct({
  operationId: id,
  publisher: Publisher,
  checkpoint: Checkpoint,
});
const Publication = Schema.Struct({
  operationId: id,
  fromGeneration: positive,
  toGeneration: positive,
  priorFacetNonce: id,
  preparedFacetNonce: id,
  checkpoint: Checkpoint,
});
const StopAcknowledgement = Schema.Struct({ requestId: id, acknowledgementId: id });

export const State = Schema.Struct({
  version: Schema.Literal(1),
  runId: id,
  nativeSessionId: id,
  control: Control,
  publisher: Publisher,
  checkpoint: Checkpoint,
  initialCheckpoint: Checkpoint,
  lifecycle: Schema.Literals([
    "accepting",
    "draining",
    "settled",
    "stopped",
    "indeterminate",
    "preparing",
    "published",
    "activation-failed",
    "recoverable",
  ]),
  admittedStepId: Schema.NullOr(id),
  lastCommittedStepId: Schema.NullOr(id),
  prepared: Schema.NullOr(Prepared),
  drainOperationId: Schema.NullOr(id),
  lastPublication: Schema.NullOr(Publication),
  lastPublicationOperationId: Schema.NullOr(id),
  stopAcknowledgement: Schema.NullOr(StopAcknowledgement),
  settlement: Schema.NullOr(Settlement),
  lastFailure: Schema.NullOr(LastFailure),
  reconciliationEvidenceId: Schema.NullOr(id),
  reconciliationOutcome: Schema.NullOr(Schema.Literals(["notApplied", "completed", "unknown"])),
});
export type State = typeof State.Type;

const decoder = Schema.decodeUnknownSync(State, { onExcessProperty: "error" });

export function encodeState(state: State) {
  const json = JSON.stringify(state);
  if (new TextEncoder().encode(json).byteLength > 262144) return fail("LIMIT");
  return json;
}

export function decodeState(value: unknown, runId: string): State {
  try {
    if (typeof value !== "string" || new TextEncoder().encode(value).byteLength > 262144)
      throw new Error("Invalid serialized state.");
    const state = decoder(JSON.parse(value));
    if (state.runId !== runId || state.control.controlKey === state.publisher.publisherKey)
      throw new Error("State identity mismatch.");
    if (state.publisher.generation < 1) throw new Error("Invalid generation.");
    if (state.lifecycle === "preparing") {
      if (!state.prepared || state.admittedStepId !== null)
        throw new Error("Invalid preparation state.");
      if (state.prepared.publisher.generation !== state.publisher.generation + 1)
        throw new Error("Prepared generation is not next.");
    } else if (state.lifecycle === "published" || state.lifecycle === "activation-failed") {
      if (state.prepared !== null || state.admittedStepId !== null)
        throw new Error("Published state retains pending work.");
    } else if (state.prepared !== null && state.lifecycle !== "indeterminate") {
      throw new Error("Unexpected prepared facet.");
    }
    if ((state.lifecycle === "settled" || state.lifecycle === "stopped") && state.admittedStepId)
      throw new Error("Settled state retains admitted work.");
    return state;
  } catch (error) {
    throw new Error("Harness thread supervisor state is corrupt.", { cause: error });
  }
}
