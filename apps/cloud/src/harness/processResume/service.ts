import * as Effect from "effect/Effect";
import {
  HarnessProcessResumeDriverError,
  HarnessProcessResumeError,
  type HarnessProcessResumeReason,
} from "./errors.ts";
import type { HarnessDurableStatePublicationResult } from "../HarnessDurableState.ts";
import type {
  HarnessProcessResumeCleanup,
  HarnessProcessResumeCheckpointReference,
  HarnessProcessResumeDriver,
  HarnessProcessResumeInput,
  HarnessProcessResumePreparedFacet,
  HarnessProcessResumePublicationResult,
  HarnessProcessResumeResult,
  HarnessProcessResumeStage,
} from "./contracts.ts";
import { samePreparedRelease, snapshotInput } from "./identity.ts";

const failure = (
  stage: HarnessProcessResumeStage,
  reason: HarnessProcessResumeReason,
  cause?: unknown,
) =>
  new HarnessProcessResumeError({
    stage,
    reason,
    recoverable: true,
    recovery: "not-recorded",
    ...(cause === undefined ? {} : { cause }),
  });

const runAt = <A>(
  stage: HarnessProcessResumeStage,
  operation: Effect.Effect<A, HarnessProcessResumeDriverError>,
  reason: HarnessProcessResumeReason = "driver-failed",
): Effect.Effect<A, HarnessProcessResumeError> =>
  operation.pipe(Effect.mapError((cause) => failure(stage, reason, cause)));

const isPublished = <Publication extends HarnessProcessResumePublicationResult>(
  publication: Publication,
): publication is Extract<Publication, { readonly status: "published" }> =>
  publication.status === "published";

const matchesControl = (
  left: Extract<HarnessProcessResumePublicationResult, { readonly status: "published" }>,
  right: HarnessProcessResumeInput["nextControl"],
) =>
  left.control.ownerId === right.ownerId &&
  left.control.incarnationId === right.incarnationId &&
  left.control.epoch === right.epoch &&
  left.control.controlKey === right.controlKey;

const sameCheckpoint = (
  left: { readonly checkpointId: string; readonly manifestSha256: string },
  right: { readonly checkpointId: string; readonly manifestSha256: string },
) => left.checkpointId === right.checkpointId && left.manifestSha256 === right.manifestSha256;

const sameReceipt = (
  left: NonNullable<
    Extract<HarnessDurableStatePublicationResult, { status: "published" }>["receipt"]
  >,
  right: NonNullable<
    Extract<HarnessDurableStatePublicationResult, { status: "published" }>["receipt"]
  >,
) =>
  left.status === "confirmed" &&
  right.status === "confirmed" &&
  left.operationId === right.operationId &&
  left.fromGeneration === right.fromGeneration &&
  left.toGeneration === right.toGeneration &&
  left.priorFacetNonce === right.priorFacetNonce &&
  left.preparedFacetNonce === right.preparedFacetNonce &&
  sameCheckpoint(left.checkpoint, right.checkpoint);

const matchesConfirmedPublication = <
  Checkpoint extends HarnessProcessResumeCheckpointReference,
  PreparedFacet extends HarnessProcessResumePreparedFacet,
>(
  publication: Extract<HarnessDurableStatePublicationResult, { readonly status: "published" }>,
  input: HarnessProcessResumeInput,
  checkpoint: Checkpoint,
  nativeSessionId: string,
  prepared: PreparedFacet,
) => {
  const { receipt, files, supervisor } = publication;
  const { snapshot, currentPublisher } = supervisor;
  const last = snapshot.lastPublication;
  const expectedCheckpoint = {
    checkpointId: checkpoint.checkpointId,
    manifestSha256: checkpoint.manifestSha256,
  };
  const expectedGeneration = input.expectedFacetGeneration + 1;

  return (
    input.publisher.generation === input.expectedFacetGeneration &&
    receipt.status === "confirmed" &&
    receipt.operationId === input.operationId &&
    receipt.fromGeneration === input.expectedFacetGeneration &&
    receipt.toGeneration === expectedGeneration &&
    receipt.priorFacetNonce === input.publisher.facetNonce &&
    receipt.preparedFacetNonce === prepared.identity.incarnationNonce &&
    sameCheckpoint(receipt.checkpoint, expectedCheckpoint) &&
    files.publication !== null &&
    sameReceipt(files.publication, receipt) &&
    sameCheckpoint(files.checkpoint, expectedCheckpoint) &&
    snapshot.lifecycle === "published" &&
    snapshot.ownerId === input.nextControl.ownerId &&
    snapshot.controlIncarnationId === input.nextControl.incarnationId &&
    snapshot.controlEpoch === input.nextControl.epoch &&
    snapshot.nativeSessionId === nativeSessionId &&
    sameCheckpoint(snapshot.checkpoint, expectedCheckpoint) &&
    snapshot.generation === expectedGeneration &&
    snapshot.facetNonce === prepared.identity.incarnationNonce &&
    snapshot.lastPublicationOperationId === input.operationId &&
    last !== null &&
    last.operationId === input.operationId &&
    last.fromGeneration === input.expectedFacetGeneration &&
    last.toGeneration === expectedGeneration &&
    last.priorFacetNonce === input.publisher.facetNonce &&
    last.preparedFacetNonce === prepared.identity.incarnationNonce &&
    sameCheckpoint(last.checkpoint, expectedCheckpoint) &&
    currentPublisher.generation === expectedGeneration &&
    currentPublisher.facetNonce === prepared.identity.incarnationNonce &&
    currentPublisher.publisherKey.length > 0
  );
};

export const createHarnessProcessResume = <
  Drain,
  Checkpoint extends HarnessProcessResumeCheckpointReference,
  PreparedFacet extends HarnessProcessResumePreparedFacet,
  Publication extends HarnessProcessResumePublicationResult,
  CleanupEvidence,
>(
  driver: HarnessProcessResumeDriver<
    Drain,
    Checkpoint,
    PreparedFacet,
    Publication,
    CleanupEvidence
  >,
) => {
  const resume = (
    supplied: HarnessProcessResumeInput,
  ): Effect.Effect<
    HarnessProcessResumeResult<PreparedFacet, Publication>,
    HarnessProcessResumeError
  > => {
    const input = snapshotInput(supplied);
    if (input === undefined) return Effect.fail(failure("fence", "invalid-input"));
    let drain: Drain | undefined;
    let prepared: PreparedFacet | undefined;
    let publication: Extract<Publication, { readonly status: "published" }> | undefined;
    let publicationResult: Publication | undefined;
    let publicationAttempted = false;

    const operation = Effect.gen(function* () {
      drain = yield* runAt("fence", driver.beginDrain(input));
      const drained = yield* runAt("drain", driver.awaitDrain(drain));
      if (drained._tag === "stale-control") return yield* failure("drain", "stale-control");
      if (drained._tag === "indeterminate") return yield* failure("settlement", "indeterminate");

      const current = yield* runAt(
        "drain",
        driver.isCurrentControl({ drain, control: input.nextControl }),
      );
      if (!current) return yield* failure("drain", "stale-control");

      const nativeSessionId = yield* runAt(
        "checkpoint",
        driver.readNativeSessionId({ drain, control: input.nextControl }),
      );
      yield* runAt(
        "checkpoint",
        driver.verifyCheckpoint({ checkpoint: drained.checkpoint, nativeSessionId }),
      );

      prepared = yield* runAt(
        "fresh-open",
        driver.prepareInert({
          drain,
          control: input.nextControl,
          publisher: input.publisher,
          operationId: input.operationId,
          checkpoint: drained.checkpoint,
          nativeSessionId,
          targetPreparedRelease: input.targetPreparedRelease,
          expectedFacetGeneration: input.expectedFacetGeneration,
        }),
      );
      if (!samePreparedRelease(prepared.identity.preparedRelease, input.targetPreparedRelease))
        return yield* failure("fresh-verification", "prepared-release-mismatch");
      yield* runAt(
        "fresh-verification",
        driver.verifyPrepared({
          drain,
          prepared,
          checkpoint: drained.checkpoint,
          nativeSessionId,
          targetPreparedRelease: input.targetPreparedRelease,
        }),
      );
      if (!samePreparedRelease(prepared.identity.preparedRelease, input.targetPreparedRelease))
        return yield* failure("fresh-verification", "prepared-release-mismatch");

      yield* runAt(
        "fresh-verification",
        driver.persistPrepared({
          drain,
          control: input.nextControl,
          publisher: input.publisher,
          operationId: input.operationId,
          prepared,
          checkpoint: drained.checkpoint,
          nativeSessionId,
          targetPreparedRelease: input.targetPreparedRelease,
          expectedFacetGeneration: input.expectedFacetGeneration,
        }),
      );

      // The composed publisher can persist one authority before its reply is lost.
      // Keep the inert placement available for repair once publication starts.
      if (!samePreparedRelease(prepared.identity.preparedRelease, input.targetPreparedRelease))
        return yield* failure("fresh-verification", "prepared-release-mismatch");
      publicationAttempted = true;
      const attempt = yield* runAt(
        "publication",
        driver.publishFreshFacet({
          drain,
          control: input.nextControl,
          operationId: input.operationId,
          prepared,
          checkpoint: drained.checkpoint,
          nativeSessionId,
          targetPreparedRelease: input.targetPreparedRelease,
          expectedFacetGeneration: input.expectedFacetGeneration,
        }),
      );
      publicationResult = attempt;
      if (!isPublished(attempt)) return yield* failure("publication", "publication-pending");
      if (!samePreparedRelease(prepared.identity.preparedRelease, input.targetPreparedRelease))
        return yield* failure("publication", "prepared-release-mismatch");
      if (!matchesControl(attempt, input.nextControl))
        return yield* failure("publication", "stale-control");
      if (
        !matchesConfirmedPublication(attempt, input, drained.checkpoint, nativeSessionId, prepared)
      )
        return yield* failure("publication", "identity-or-checkpoint-mismatch");
      publication = attempt;

      yield* runAt(
        "activation",
        driver.activate({
          drain,
          control: input.nextControl,
          operationId: input.operationId,
          prepared,
          publication,
        }),
        "activation-failed",
      );
      return {
        preparedFacet: prepared,
        publication,
      };
    });

    return operation.pipe(
      Effect.catch((original) =>
        Effect.gen(function* () {
          let cleanup: HarnessProcessResumeCleanup<CleanupEvidence> | null = null;
          let cleanupCallCause: unknown;
          if (prepared !== undefined && !publicationAttempted) {
            const cleanupResult = yield* Effect.uninterruptible(
              driver.cleanupPrepared(prepared).pipe(
                Effect.map((evidence) => ({ ok: true as const, evidence })),
                Effect.catch((cause) => Effect.succeed({ ok: false as const, cause })),
              ),
            );
            if (cleanupResult.ok) cleanup = cleanupResult.evidence;
            else cleanupCallCause = cleanupResult.cause;
          }

          const cleanupFailed = cleanupCallCause !== undefined || cleanup?._tag === "incomplete";
          const finalStage = cleanupFailed ? "cleanup" : original.stage;
          const finalReason = cleanupFailed ? "cleanup-failed" : original.reason;
          const finalCause = cleanupCallCause ?? original.cause;
          const priorCause = cleanupFailed ? original.cause : undefined;
          let recovery: "recorded" | "claim-changed" | "record-failed" | "not-recorded" =
            "not-recorded";
          let failedStage: HarnessProcessResumeStage | undefined;
          let recoveryCause: unknown;

          if (drain !== undefined) {
            const current = yield* driver
              .isCurrentControl({ drain, control: input.nextControl })
              .pipe(
                Effect.map((value) => ({ value })),
                Effect.catch((cause) => Effect.succeed({ cause })),
              );
            if ("value" in current && current.value) {
              const recorded = yield* driver
                .recordFailure({
                  drain,
                  control: input.nextControl,
                  operationId: input.operationId,
                  expectedFacetGeneration: input.expectedFacetGeneration,
                  targetPreparedRelease: input.targetPreparedRelease,
                  stage: finalStage,
                  ...(cleanupFailed ? { failedStage: original.stage } : {}),
                  reason: finalReason,
                  ...(cleanupFailed ? { priorReason: original.reason } : {}),
                  ...(prepared === undefined ? {} : { prepared }),
                  ...(publicationResult === undefined ? {} : { publication: publicationResult }),
                  cleanup,
                })
                .pipe(
                  Effect.map((value) => ({ ok: true as const, recovery: value })),
                  Effect.catch((cause) => Effect.succeed({ ok: false as const, cause })),
                );
              if (recorded.ok) recovery = recorded.recovery;
              else {
                recovery = "record-failed";
                failedStage = original.stage;
                recoveryCause = recorded.cause;
              }
            } else if ("cause" in current) {
              recovery = "record-failed";
              failedStage = original.stage;
              recoveryCause = current.cause;
            } else recovery = "claim-changed";
          }

          if (recovery === "record-failed")
            return yield* new HarnessProcessResumeError({
              stage: "recovery",
              reason: "recovery-write-failed",
              recoverable: true,
              recovery,
              ...(failedStage === undefined ? {} : { failedStage }),
              ...(cleanupFailed ? { priorReason: original.reason } : {}),
              ...(recoveryCause === undefined ? {} : { cause: recoveryCause }),
              ...((original.cause ?? cleanupCallCause) === undefined
                ? {}
                : { priorCause: original.cause ?? cleanupCallCause }),
            });

          return yield* new HarnessProcessResumeError({
            stage: finalStage,
            reason: finalReason,
            recoverable: true,
            recovery,
            ...(cleanupFailed ? { failedStage: original.stage } : {}),
            ...(cleanupFailed ? { priorReason: original.reason } : {}),
            ...(finalCause === undefined ? {} : { cause: finalCause }),
            ...(priorCause === undefined ? {} : { priorCause }),
          });
        }),
      ),
    );
  };

  return { resume };
};
