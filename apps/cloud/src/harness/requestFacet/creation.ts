import { sameCheckpoint } from "../processResume/runStoreState.ts";
import { NATIVE_SESSION_UUID } from "../processCreation/identity.ts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import * as Scope from "effect/Scope";
import {
  HarnessRequestFacetError,
  type HarnessRequestFacetOptions,
  type HarnessRequestFacetCreationRequest,
  type HarnessRequestFacetCreationEvidence,
  type HarnessRequestFacetCreationObservation,
} from "./contracts.ts";
import type { HarnessRequestPublisher, HarnessRunStoreResult } from "../HarnessRunStore.ts";

const sameInput = (a: HarnessRequestFacetCreationRequest, b: HarnessRequestFacetCreationRequest) =>
  a.operationId === b.operationId &&
  a.targetFacetNonce === b.targetFacetNonce &&
  a.publisherKey === b.publisherKey;

export function createFreshRequestPreparation(
  options: HarnessRequestFacetOptions,
  ownerScope: Scope.Closeable,
  state: {
    readonly available: () => boolean;
    readonly install: (evidence: HarnessRequestFacetCreationEvidence) => void;
    readonly poison: () => void;
  },
) {
  let unresolvedCleanup:
    | { readonly scope: Scope.Closeable; readonly failure: HarnessRequestFacetError }
    | undefined;
  let created:
    | {
        readonly input: HarnessRequestFacetCreationRequest;
        readonly observation: HarnessRequestFacetCreationObservation;
      }
    | undefined;
  const checkPublisher = (publisher: HarnessRequestPublisher) =>
    Effect.gen(function* () {
      if (
        created !== undefined &&
        (publisher.generation !== 1 ||
          publisher.facetNonce !== created.input.targetFacetNonce ||
          publisher.publisherKey !== created.input.publisherKey)
      )
        return yield* Effect.fail(
          new HarnessRequestFacetError("Fresh execution must use its bound initial publisher."),
        );
    });
  const checkPublication = (admitted: HarnessRunStoreResult) =>
    Effect.gen(function* () {
      if (created === undefined) return;
      const facet = admitted.snapshot.requests?.facets.find(
        (candidate) =>
          candidate.generation === 1 && candidate.facetNonce === created?.input.targetFacetNonce,
      );
      const expected = created.observation.checkpoint;
      if (
        facet === undefined ||
        facet.operationId !== created.input.operationId ||
        !sameCheckpoint(facet.checkpoint, expected)
      ) {
        state.poison();
        return yield* Effect.fail(
          new HarnessRequestFacetError(
            "Fresh execution has no matching committed initial binding.",
          ),
        );
      }
    });
  const start = (supplied: HarnessRequestFacetCreationRequest) =>
    Effect.gen(function* () {
      const input = { ...supplied };
      if (created !== undefined) {
        if (sameInput(created.input, input)) return structuredClone(created.observation);
        return yield* Effect.fail(
          new HarnessRequestFacetError("Fresh native creation belongs to another operation."),
        );
      }
      if (
        !state.available() ||
        !options.startFresh ||
        !input.operationId ||
        input.targetFacetNonce !== options.facetNonce ||
        input.publisherKey.length < 32 ||
        input.publisherKey.length > 128
      )
        return yield* Effect.fail(
          new HarnessRequestFacetError("Fresh native creation identity is invalid or unavailable."),
        );
      const create = options.startFresh;
      const scope = yield* Scope.make();
      return yield* Effect.gen(function* () {
        const observed = yield* create(input).pipe(Scope.provide(scope));
        if (
          observed.facetNonce !== options.facetNonce ||
          !NATIVE_SESSION_UUID.test(observed.nativeSessionId) ||
          observed.filesCheckpoint.parentCheckpointId !== null ||
          observed.filesCheckpoint.checkpointId !== observed.checkpoint.native.id ||
          observed.manifestRevision !== observed.checkpoint.filesystem.sha256 ||
          !observed.joined.invocationRpc ||
          !observed.joined.fetch ||
          !observed.joined.ports ||
          typeof observed.runtime?.run !== "function"
        )
          return yield* Effect.fail(
            new HarnessRequestFacetError(
              "Fresh native creation did not return a complete initial checkpoint.",
            ),
          );
        yield* options.verify(observed.checkpoint.native, "native");
        yield* options.verify(observed.checkpoint.filesystem, "filesystem");
        yield* Scope.addFinalizer(ownerScope, Scope.close(scope, Exit.void));
        const observation = {
          facetNonce: observed.facetNonce,
          nativeSessionId: observed.nativeSessionId,
          checkpoint: structuredClone(observed.checkpoint),
          filesCheckpoint: structuredClone(observed.filesCheckpoint),
          manifestRevision: observed.manifestRevision,
          joined: { ...observed.joined },
        };
        state.install(observed);
        created = { input, observation };
        return structuredClone(observation);
      }).pipe(
        Effect.onError((cause) =>
          Effect.gen(function* () {
            state.poison();
            const cleanup = yield* Effect.exit(Scope.close(scope, Exit.void));
            if (Exit.isFailure(cleanup)) {
              const failure = new HarnessRequestFacetError(
                "Fresh native preparation cleanup is unknown.",
                { cause: Cause.combine(cause, cleanup.cause) },
              );
              unresolvedCleanup = { scope, failure };
              return yield* Effect.die(failure);
            }
          }),
        ),
      );
    });
  const cleanup = Effect.suspend(() =>
    unresolvedCleanup === undefined ? Effect.void : Effect.die(unresolvedCleanup.failure),
  );
  return { cleanup, start, started: () => created !== undefined, checkPublisher, checkPublication };
}
