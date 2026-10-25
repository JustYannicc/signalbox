import {
  type ReviewDiffFileStat,
  type ReviewDiffPreviewInput,
  type ReviewDiffPreviewSource,
  VcsUnsupportedOperationError,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import { request } from "../rpc/client.ts";
import { Atom } from "effect/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentQueryAtomFamily,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

// signalbox: requests pinned to a source's commits (#864)
type ReviewFilePatchRequest = ReviewDiffPreviewInput & {
  readonly file: NonNullable<ReviewDiffPreviewInput["file"]>;
};

/**
 * One file of `source`, as `review.getDiffPreview` reads it on its own. A
 * source that names the exact commits it compared is read at those, so the
 * file matches the stats it was listed with even after its branch moves.
 */
export function reviewFilePatchRequest(input: {
  readonly cwd: string;
  readonly source: ReviewDiffPreviewSource;
  readonly file: Pick<ReviewDiffFileStat, "path" | "previousPath">;
  /** The base the panel asked for, when the source names none. */
  readonly fallbackBaseRef?: string | null;
  readonly ignoreWhitespace?: boolean;
}): ReviewFilePatchRequest {
  const baseRef = input.source.baseRef ?? input.fallbackBaseRef;
  return {
    cwd: input.cwd,
    ...(baseRef ? { baseRef } : {}),
    ...(input.ignoreWhitespace === undefined ? {} : { ignoreWhitespace: input.ignoreWhitespace }),
    file: {
      path: input.file.path,
      previousPath: input.file.previousPath,
      sourceKind: input.source.kind,
      ...(input.source.revision ? { revision: input.source.revision } : {}),
    },
  };
}

/** Where to read a source's whole files: the commits it compared, else the refs it names. */
export function reviewSourceContentRefs(source: ReviewDiffPreviewSource): {
  readonly baseRef: string | null;
  readonly headRef: string | null;
} {
  return source.revision
    ? { baseRef: source.revision.baseSha, headRef: source.revision.headSha }
    : { baseRef: source.baseRef, headRef: source.headRef };
}

export function createReviewEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const patchReads = Semaphore.makeUnsafe(4);
  const diffFileScheduler = createAtomCommandScheduler();
  return {
    diffPreview: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:review:diff-preview",
      tag: WS_METHODS.reviewGetDiffPreview,
      staleTimeMs: 5_000,
    }),
    diffFilePatch: createEnvironmentQueryAtomFamily(runtime, {
      label: "environment-data:review:diff-file-patch",
      staleTimeMs: 5 * 60_000,
      execute: (input: {
        request: ReviewDiffPreviewInput & { file: NonNullable<ReviewDiffPreviewInput["file"]> };
        cacheKey: string;
      }) =>
        request(WS_METHODS.reviewGetDiffPreview, input.request).pipe(
          patchReads.withPermit,
          Effect.flatMap((result) => {
            const source = result.sources.find(
              (source) => source.kind === input.request.file.sourceKind,
            );
            return source
              ? Effect.succeed(source)
              : Effect.fail(
                  new VcsUnsupportedOperationError({
                    operation: "review.diffFilePatch",
                    kind: "git",
                    detail: "Diff no longer available. Refresh the comparison.",
                  }),
                );
          }),
        ),
    }),
    diffFileContents: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:review:diff-file-contents",
      tag: WS_METHODS.reviewGetDiffFileContents,
      scheduler: diffFileScheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([
            environmentId,
            input.cwd,
            input.sourceKind,
            input.baseRef,
            input.headRef,
            input.oldPath,
            input.newPath,
            input.changeType,
          ]),
      },
    }),
  };
}
