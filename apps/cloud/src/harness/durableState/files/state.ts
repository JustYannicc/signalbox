import * as Schema from "effect/Schema";
import { capability, digest, id, positive } from "../shared.ts";

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
const CheckpointRef = Schema.Struct({ checkpointId: id, manifestSha256: digest });
const Publication = Schema.Struct({
  operationId: id,
  fromGeneration: positive,
  toGeneration: positive,
  priorFacetNonce: id,
  preparedFacetNonce: id,
  checkpoint: CheckpointRef,
  status: Schema.Literals(["pending", "confirmed"]),
});

export const State = Schema.Struct({
  version: Schema.Literal(1),
  runId: id,
  control: Control,
  publisher: Publisher,
  initialCheckpoint: CheckpointRef,
  checkpoint: CheckpointRef,
  lifecycle: Schema.Literals([
    "accepting",
    "draining",
    "publishing",
    "published",
    "activation-failed",
  ]),
  activeStepId: Schema.NullOr(id),
  lastCommittedStepId: Schema.NullOr(id),
  pendingPublisher: Schema.NullOr(Publisher),
  lastPublication: Schema.NullOr(Publication),
  pendingPublication: Schema.NullOr(Publication),
  controlSyncOperationId: Schema.NullOr(id),
  activationOperationId: Schema.NullOr(id),
});
export type State = typeof State.Type;

const decoder = Schema.decodeUnknownSync(State, { onExcessProperty: "error" });

export function encodeState(state: State) {
  const json = JSON.stringify(state);
  if (new TextEncoder().encode(json).byteLength > 65536)
    throw new Error("Files store metadata exceeds its storage bound.");
  return json;
}

export function decodeState(value: unknown, runId: string): State {
  try {
    if (typeof value !== "string" || new TextEncoder().encode(value).byteLength > 65536)
      throw new Error("Invalid serialized state.");
    const state = decoder(JSON.parse(value));
    if (
      state.runId !== runId ||
      state.control.controlKey === state.publisher.publisherKey ||
      state.checkpoint.checkpointId === ""
    )
      throw new Error("Files state identity mismatch.");
    const publishing = state.lifecycle === "publishing";
    if (
      publishing !== (state.pendingPublisher !== null) ||
      publishing !== (state.pendingPublication !== null)
    )
      throw new Error("Pending publisher does not match phase.");
    if (state.pendingPublication && state.pendingPublication.status !== "pending")
      throw new Error("Unconfirmed receipt outside publication.");
    if (state.lastPublication && state.lastPublication.status !== "confirmed")
      throw new Error("Confirmed receipt history is invalid.");
    if (
      state.lastPublication?.toGeneration !== undefined &&
      state.lastPublication.toGeneration !== state.publisher.generation
    )
      throw new Error("Confirmed receipt does not match the active publisher.");
    if (state.activeStepId !== null && state.pendingPublication !== null)
      throw new Error("Publication overlaps an admitted step.");
    return state;
  } catch (error) {
    throw new Error("Harness files store state is corrupt.", { cause: error });
  }
}
