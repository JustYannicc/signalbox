import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import {
  HarnessRequestFacetError,
  type HarnessFacetRequestContext,
  type HarnessFacetRequestRuntime,
  type HarnessRequestFacet,
  type HarnessRequestFacetOptions,
  type HarnessRequestFacetPreparationEvidence,
  type HarnessRequestFacetPreparationObservation,
  type HarnessRequestFacetPreparationRequest,
} from "./contracts.ts";
import type {
  HarnessRequestCheckpoint,
  HarnessRequestPublisher,
  HarnessRunArtifact,
} from "../HarnessRunStore.ts";
const sameReference = (left: HarnessRunArtifact, right: HarnessRunArtifact) =>
  left.id === right.id && left.bytes === right.bytes && left.sha256 === right.sha256;

const failure = (message: string, cause?: unknown) =>
  new HarnessRequestFacetError(message, { cause });
const samePublisher = (left: HarnessRequestPublisher, right: HarnessRequestPublisher) =>
  left.generation === right.generation &&
  left.facetNonce === right.facetNonce &&
  left.publisherKey === right.publisherKey;
const sameCheckpoint = (
  left: HarnessRequestCheckpoint | undefined,
  right: HarnessRequestCheckpoint,
) =>
  left !== undefined &&
  sameReference(left.native, right.native) &&
  sameReference(left.filesystem, right.filesystem);

const samePreparation = (
  left: HarnessRequestFacetPreparationRequest,
  right: HarnessRequestFacetPreparationRequest,
) =>
  left.operationId === right.operationId &&
  left.targetFacetNonce === right.targetFacetNonce &&
  left.nativeSessionId === right.nativeSessionId &&
  left.checkpointId === right.checkpointId &&
  left.manifestRevision === right.manifestRevision &&
  left.priorFacetNonce === right.priorFacetNonce &&
  left.expectedFacetGeneration === right.expectedFacetGeneration;

const joined = (value: HarnessRequestFacetPreparationEvidence["joined"]) =>
  value !== undefined &&
  value.invocationRpc === true &&
  value.fetch === true &&
  value.ports === true;

export const createHarnessRequestFacet = (
  options: HarnessRequestFacetOptions,
): Effect.Effect<HarnessRequestFacet, HarnessRequestFacetError, Scope.Scope> =>
  Effect.gen(function* () {
    if (!options.runId || !options.facetNonce)
      return yield* Effect.fail(failure("Harness request facet identity is missing."));
    const scope = yield* Scope.make();
    let disposed = false;
    let poisoned = false;
    let runtime: HarnessFacetRequestRuntime | undefined;
    let publisher: HarnessRequestPublisher | undefined;
    let checkpoint: HarnessRequestCheckpoint | undefined;
    let active: HarnessFacetRequestContext | undefined;
    let preparation:
      | {
          readonly input: HarnessRequestFacetPreparationRequest;
          readonly observation: HarnessRequestFacetPreparationObservation;
          readonly runtime: HarnessFacetRequestRuntime;
        }
      | undefined;
    let preparationFailure: HarnessRequestFacetError | undefined;
    const preparationLock = yield* Semaphore.make(1);
    const ownerSignal = yield* Effect.abortSignal.pipe(Scope.provide(scope));
    const progressLock = yield* Semaphore.make(1);
    const dispose = yield* Effect.cached(
      preparationLock
        .withPermits(1)(
          Effect.sync(() => {
            disposed = true;
          }).pipe(Effect.andThen(Scope.close(scope, Exit.void))),
        )
        .pipe(Effect.uninterruptible),
    );
    yield* Effect.addFinalizer(() => dispose);
    const execute = (command: unknown) =>
      Effect.tryPromise({
        try: () => options.store.execute(command),
        catch: (cause) => failure("Harness request store rejected the operation.", cause),
      });
    const prepareInert: HarnessRequestFacet["prepareInert"] = (supplied) =>
      preparationLock.withPermits(1)(
        Effect.gen(function* () {
          if (disposed || poisoned)
            return yield* Effect.fail(failure("Harness facet requires a fresh restoration."));
          if (preparation !== undefined) {
            if (!samePreparation(preparation.input, supplied))
              return yield* Effect.fail(
                failure("Harness facet preparation belongs to another operation."),
              );
            return preparation.observation;
          }
          if (preparationFailure !== undefined) return yield* Effect.fail(preparationFailure);
          if (!options.prepareInert) {
            preparationFailure = failure("Harness host does not support inert preparation.");
            poisoned = true;
            return yield* Effect.fail(preparationFailure);
          }
          if (
            !supplied.operationId ||
            supplied.targetFacetNonce !== options.facetNonce ||
            !supplied.nativeSessionId ||
            !supplied.checkpointId ||
            !supplied.manifestRevision ||
            !supplied.priorFacetNonce ||
            !Number.isSafeInteger(supplied.expectedFacetGeneration) ||
            supplied.expectedFacetGeneration < 0
          )
            return yield* Effect.fail(failure("Harness facet preparation identity is invalid."));

          const preparationScope = yield* Scope.make();
          const observed = yield* options
            .prepareInert(supplied)
            .pipe(
              Scope.provide(preparationScope),
              Effect.mapError((cause) =>
                failure("Harness host could not prepare the committed checkpoint inert.", cause),
              ),
            )
            .pipe(
              Effect.catchCause((cause) =>
                Scope.close(preparationScope, Exit.void).pipe(
                  Effect.catchCause((cleanupCause) => {
                    poisoned = true;
                    preparationFailure = failure(
                      "Harness preparation failed and its cleanup is unknown.",
                      cleanupCause,
                    );
                    return Effect.fail(preparationFailure);
                  }),
                  Effect.andThen(
                    Effect.sync(() => {
                      poisoned = true;
                      preparationFailure ??= failure(
                        "Harness host could not prepare the committed checkpoint inert.",
                        cause,
                      );
                    }),
                  ),
                  Effect.andThen(Effect.fail(preparationFailure!)),
                ),
              ),
            );

          const accept = Effect.gen(function* () {
            if (
              observed.facetNonce !== supplied.targetFacetNonce ||
              observed.nativeSessionId !== supplied.nativeSessionId ||
              observed.checkpoint.native.id !== supplied.checkpointId ||
              observed.checkpoint.filesystem.sha256 !== supplied.manifestRevision ||
              observed.manifestRevision !== supplied.manifestRevision ||
              !joined(observed.joined) ||
              typeof observed.runtime?.run !== "function"
            )
              return yield* Effect.fail(
                failure(
                  "Harness host preparation did not observe the requested identity and checkpoint.",
                ),
              );
            yield* options.verify(observed.checkpoint.native, "native");
            yield* options.verify(observed.checkpoint.filesystem, "filesystem");
            yield* Scope.addFinalizer(scope, Scope.close(preparationScope, Exit.void));
            runtime = observed.runtime;
            checkpoint = observed.checkpoint;
            const observation: HarnessRequestFacetPreparationObservation = {
              facetNonce: observed.facetNonce,
              nativeSessionId: observed.nativeSessionId,
              checkpoint: observed.checkpoint,
              manifestRevision: observed.manifestRevision,
              joined: observed.joined,
            };
            preparation = { input: { ...supplied }, observation, runtime: observed.runtime };
            return observation;
          }).pipe(
            Effect.catchCause((cause) =>
              Scope.close(preparationScope, Exit.void).pipe(
                Effect.catchCause((cleanupCause) => {
                  poisoned = true;
                  preparationFailure = failure(
                    "Harness preparation cleanup is unknown.",
                    cleanupCause,
                  );
                  return Effect.fail(preparationFailure);
                }),
                Effect.andThen(
                  Effect.sync(() => {
                    poisoned = true;
                    preparationFailure ??= failure(
                      "Harness host preparation did not complete with verified evidence.",
                      cause,
                    );
                  }),
                ),
                Effect.andThen(Effect.fail(preparationFailure!)),
              ),
            ),
          );
          return yield* accept;
        }),
      );
    const run: HarnessRequestFacet["run"] = (supplied) =>
      Effect.gen(function* () {
        const input = { ...supplied, publisher: { ...supplied.publisher } };
        if (
          disposed ||
          poisoned ||
          input.publisher.facetNonce !== options.facetNonce ||
          (publisher !== undefined && !samePublisher(publisher, input.publisher))
        )
          return yield* Effect.fail(failure("Harness facet requires a fresh restoration."));
        if (
          preparation !== undefined &&
          (input.publisher.facetNonce !== preparation.input.targetFacetNonce ||
            input.publisher.generation !== preparation.input.expectedFacetGeneration + 1)
        )
          return yield* Effect.fail(
            failure("Published request does not match the inert facet preparation."),
          );
        const admitted = yield* execute({
          type: "request.admit",
          runId: options.runId,
          publisher: input.publisher,
          requestId: input.requestId,
        });
        if (preparation !== undefined) {
          const requests = admitted.snapshot.requests;
          const published = requests?.facets.find(
            (candidate) =>
              candidate.generation === input.publisher.generation &&
              candidate.facetNonce === input.publisher.facetNonce,
          );
          if (
            requests === undefined ||
            published === undefined ||
            published.operationId !== preparation.input.operationId ||
            !sameCheckpoint(preparation.observation.checkpoint, requests.checkpoint) ||
            !sameCheckpoint(preparation.observation.checkpoint, published.checkpoint)
          ) {
            poisoned = true;
            return yield* Effect.fail(
              failure("Published request checkpoint differs from inert preparation."),
            );
          }
        }
        if (admitted.action !== "execute-once") return admitted;
        const requests = admitted.snapshot.requests;
        const entry = requests?.entries.find(
          (candidate) => candidate.request.requestId === input.requestId,
        );
        if (!requests || !entry || active !== undefined) {
          poisoned = true;
          return yield* Effect.fail(failure("Harness request admission is inconsistent."));
        }
        publisher = input.publisher;
        let sequence = entry.progress?.sequence ?? 0;
        const signal = AbortSignal.any([ownerSignal, yield* Effect.abortSignal]);
        const check = Effect.gen(function* () {
          if (active !== context || signal.aborted)
            return yield* Effect.fail(failure("Harness request is no longer active."));
          yield* execute({
            type: "request.check",
            runId: options.runId,
            publisher: input.publisher,
            requestId: input.requestId,
          });
        });
        const context: HarnessFacetRequestContext = {
          requestId: input.requestId,
          publisher: input.publisher,
          signal,
          check,
          progress: (kind, reference) =>
            progressLock.withPermits(1)(
              Effect.gen(function* () {
                yield* check;
                yield* options.verify(reference, "progress");
                yield* execute({
                  type: "request.progress",
                  runId: options.runId,
                  publisher: input.publisher,
                  requestId: input.requestId,
                  progress: { sequence: sequence + 1, kind, reference },
                });
                sequence += 1;
              }),
            ),
        };
        active = context;
        return yield* Effect.gen(function* () {
          yield* check;
          yield* options.verify(entry.request.input, "input");
          if (runtime === undefined) {
            yield* options.verify(requests.checkpoint.native, "native");
            yield* options.verify(requests.checkpoint.filesystem, "filesystem");
            runtime = yield* options.open(requests.checkpoint, context).pipe(Scope.provide(scope));
            checkpoint = requests.checkpoint;
          }
          if (!sameCheckpoint(checkpoint, requests.checkpoint))
            return yield* Effect.fail(failure("Harness heap differs from the durable checkpoint."));
          yield* check;
          const completed = yield* runtime.run(entry.request.input, context);
          return yield* progressLock.withPermits(1)(
            Effect.gen(function* () {
              yield* check;
              yield* options.verify(completed.result, "result");
              yield* options.verify(completed.checkpoint.native, "native");
              yield* options.verify(completed.checkpoint.filesystem, "filesystem");
              const committed = yield* execute({
                type: "request.finish",
                runId: options.runId,
                publisher: input.publisher,
                requestId: input.requestId,
                finish: { ...completed, sequence: sequence + 1 },
              });
              if (committed.action !== "committed")
                return yield* Effect.fail(failure("Harness request completion was not committed."));
              checkpoint = completed.checkpoint;
              return committed;
            }),
          );
        }).pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => {
              if (Exit.isFailure(exit)) poisoned = true;
              if (active === context) active = undefined;
            }),
          ),
        );
      }).pipe(Effect.scoped);
    return { facetNonce: options.facetNonce, prepareInert, run, dispose };
  });
