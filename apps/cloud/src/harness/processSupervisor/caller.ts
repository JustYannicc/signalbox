import * as Effect from "effect/Effect";
import { HarnessProcessResumeError } from "../HarnessProcessResume.ts";
import type {
  HarnessProcessSupervisorCaller,
  HarnessProcessSupervisorRestart,
} from "./contracts.ts";
import { sameCheckpoint, sameIncarnation } from "./state.ts";

const mismatch = () =>
  new HarnessProcessResumeError({
    stage: "publication",
    reason: "identity-or-checkpoint-mismatch",
    recoverable: true,
    recovery: "not-recorded",
  });

/** C owns stop/join, drain settlement, verified restore, publication and activation.
 * This adapter binds that result to the supervisor's unfinished turn and completed checkpoint. */
export const resumeThroughCaller = (
  caller: HarnessProcessSupervisorCaller,
  intent: HarnessProcessSupervisorRestart,
) =>
  Effect.gen(function* () {
    const input = yield* caller.prepareResume(structuredClone(intent));
    if (
      input.operationId !== intent.operationId ||
      input.expectedFacetGeneration !== intent.incarnation.generation ||
      !sameIncarnation(input.publisher, intent.incarnation)
    )
      return yield* mismatch();

    const result = yield* caller.processResume.resume(input);
    const { receipt, supervisor, files } = result.publication;
    const { snapshot, currentPublisher } = supervisor;
    const generation = intent.incarnation.generation + 1;
    const facetNonce = result.preparedFacet.identity.incarnationNonce;
    if (
      facetNonce === intent.incarnation.facetNonce ||
      snapshot.nativeSessionId !== intent.checkpoint.nativeSessionId ||
      snapshot.generation !== generation ||
      snapshot.facetNonce !== facetNonce ||
      currentPublisher.generation !== generation ||
      currentPublisher.facetNonce !== facetNonce ||
      receipt.operationId !== intent.operationId ||
      receipt.status !== "confirmed" ||
      receipt.fromGeneration !== intent.incarnation.generation ||
      receipt.toGeneration !== generation ||
      receipt.priorFacetNonce !== intent.incarnation.facetNonce ||
      receipt.preparedFacetNonce !== facetNonce ||
      !sameCheckpoint(snapshot.checkpoint, intent.checkpoint) ||
      !sameCheckpoint(receipt.checkpoint, intent.checkpoint) ||
      !sameCheckpoint(files.checkpoint, intent.checkpoint)
    )
      return yield* mismatch();
    return { generation, facetNonce };
  });
