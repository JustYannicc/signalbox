import type {
  ModelSelection,
  PullRequestActivity,
  PullRequestDetail,
  PullRequestDiffResult,
  PullRequestDiffRevision,
  TextGenerationError,
} from "@t3tools/contracts";
import { decodeJsonReply } from "@t3tools/provider-core/server/textGenerationOperations";
import type {
  ReviewGuideGenerationResult,
  ReviewGuideStackLayer,
} from "@t3tools/provider-core/server/textGeneration";
import {
  normalizeReviewGuide,
  parseReviewGuidePatch,
} from "@t3tools/provider-core/server/reviewGuideNormalize";
import { reviewGuideInputFromPullRequest } from "@t3tools/provider-core/server/reviewGuideInput";
import { buildReviewGuidePromptFromDiff } from "@t3tools/provider-core/server/textGenerationPrompts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { ModelCompletion, ModelCompletionError } from "../models/ModelCompletion.ts";
import type { ModelPoolRoute } from "../models/ModelProtocol.ts";

const MAX_DIFF_SLICES = 30;
const MAX_DIFF_BYTES = 1_000_000;
const FULL_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/iu;

export class PullRequestGuideGenerationError extends Schema.TaggedError<PullRequestGuideGenerationError>()(
  "PullRequestGuideGenerationError",
  {
    code: Schema.Literals([
      "invalid-revision",
      "revision-mismatch",
      "incomplete-diff",
      "diff-too-large",
    ]),
    reason: Schema.String,
  },
) {
  override get message() {
    return this.reason;
  }
}

export interface PullRequestGuideGenerationInput<E = never> {
  readonly detail: PullRequestDetail;
  readonly activity: PullRequestActivity;
  readonly instructions?: string | undefined;
  readonly stack?: ReadonlyArray<ReviewGuideStackLayer> | undefined;
  readonly modelSelection: ModelSelection;
  readonly pool: ModelPoolRoute;
  /** The caller closes over one PR reference; cursors pin each later read to the first revision. */
  readonly readDiff: (cursor: string | undefined) => Effect.Effect<PullRequestDiffResult, E>;
}

export interface PullRequestGuideGenerationResult {
  readonly revision: PullRequestDiffRevision;
  readonly guide: ReviewGuideGenerationResult;
}

type GenerationError<E> =
  | E
  | ModelCompletionError
  | PullRequestGuideGenerationError
  | TextGenerationError;

export class PullRequestGuideGeneration extends Context.Service<
  PullRequestGuideGeneration,
  {
    readonly generate: <E>(
      input: PullRequestGuideGenerationInput<E>,
    ) => Effect.Effect<PullRequestGuideGenerationResult, GenerationError<E>>;
  }
>()("@signalbox/cloud/github/PullRequestGuideGeneration") {}

const invalid = (code: PullRequestGuideGenerationError["code"], reason: string) =>
  new PullRequestGuideGenerationError({ code, reason });

const sameRevision = (left: PullRequestDiffRevision, right: PullRequestDiffRevision) =>
  left.baseSha.toLowerCase() === right.baseSha.toLowerCase() &&
  left.headSha.toLowerCase() === right.headSha.toLowerCase();

const completePatch = (patch: string, fileCount: number) => {
  const sections = patch
    .split(/(?=^diff --git )/mu)
    .filter((section) => section.startsWith("diff --git "));
  if (sections.length !== fileCount) return false;
  return sections.every((section) => {
    const hasHunk = /^@@ -\d+/mu.test(section);
    const hasCompleteMetadataOnlyChange =
      /^(?:rename from |new file mode |deleted file mode |old mode |new mode )/mu.test(section);
    return hasHunk || hasCompleteMetadataOnlyChange;
  });
};

const make = Effect.gen(function* () {
  const completion = yield* ModelCompletion;

  const generate: PullRequestGuideGeneration["Service"]["generate"] = <E>(
    input: PullRequestGuideGenerationInput<E>,
  ) =>
    Effect.gen(function* () {
      const expectedHead = input.detail.headSha;
      if (expectedHead === undefined || !FULL_SHA.test(expectedHead)) {
        return yield* invalid(
          "invalid-revision",
          "The pull request has no valid head commit for a remote review guide.",
        );
      }
      if (!Number.isSafeInteger(input.detail.changedFiles) || input.detail.changedFiles < 0) {
        return yield* invalid(
          "incomplete-diff",
          "The pull request did not report a complete changed-file count.",
        );
      }

      const readSlice = (
        cursor: string | undefined,
      ): Effect.Effect<
        PullRequestDiffResult & { readonly revision: PullRequestDiffRevision },
        E | PullRequestGuideGenerationError
      > =>
        input.readDiff(cursor).pipe(
          Effect.flatMap((slice) => {
            const revision = slice.revision;
            if (
              revision === undefined ||
              !FULL_SHA.test(revision.baseSha) ||
              !FULL_SHA.test(revision.headSha)
            ) {
              return Effect.fail(
                invalid(
                  "invalid-revision",
                  "The pull request diff did not include a valid immutable revision.",
                ),
              );
            }
            if (revision.headSha.toLowerCase() !== expectedHead.toLowerCase()) {
              return Effect.fail(
                invalid(
                  "revision-mismatch",
                  "The pull request head changed while its review guide diff was being read.",
                ),
              );
            }
            if (slice.truncated || (slice.omittedFileStats?.length ?? 0) > 0) {
              return Effect.fail(
                invalid(
                  "incomplete-diff",
                  "The pull request host could not provide every changed file hunk.",
                ),
              );
            }
            return Effect.succeed({ ...slice, revision });
          }),
        );

      const first = yield* readSlice(undefined);
      const revision = first.revision;
      const chunks = [first.patch];
      const cursors = new Set<string>();
      let nextCursor = first.nextCursor;
      let slices = 1;
      let patchBytes = new TextEncoder().encode(first.patch).byteLength;
      if (patchBytes > MAX_DIFF_BYTES) {
        return yield* invalid(
          "diff-too-large",
          "The pull request diff is too large to generate a complete review guide.",
        );
      }

      while (nextCursor !== null) {
        if (slices >= MAX_DIFF_SLICES || cursors.has(nextCursor)) {
          return yield* invalid(
            "incomplete-diff",
            "The pull request host did not finish its paginated diff.",
          );
        }
        cursors.add(nextCursor);
        const slice = yield* readSlice(nextCursor);
        if (!sameRevision(revision, slice.revision)) {
          return yield* invalid(
            "revision-mismatch",
            "The pull request diff pages came from different base or head commits.",
          );
        }
        patchBytes += new TextEncoder().encode(slice.patch).byteLength;
        if (patchBytes > MAX_DIFF_BYTES) {
          return yield* invalid(
            "diff-too-large",
            "The pull request diff is too large to generate a complete review guide.",
          );
        }
        chunks.push(slice.patch);
        slices += 1;
        nextCursor = slice.nextCursor;
      }

      const patch = chunks.join("");
      const change = parseReviewGuidePatch(patch);
      if (
        change.files.length === 0 ||
        change.files.length !== input.detail.changedFiles ||
        new Set(change.files).size !== change.files.length ||
        !completePatch(patch, change.files.length)
      ) {
        return yield* invalid(
          "incomplete-diff",
          "The pull request diff did not account for every changed file and its available hunks.",
        );
      }

      const prompt = buildReviewGuidePromptFromDiff({
        ...reviewGuideInputFromPullRequest(input.detail, input.activity, revision.baseSha),
        headCommit: revision.headSha,
        diff: patch,
        instructions: input.instructions,
        stack: input.stack,
      });
      const reply = yield* completion.complete({
        pool: input.pool,
        modelSelection: input.modelSelection,
        prompt: prompt.prompt,
      });
      const generated = yield* decodeJsonReply(
        { operation: "generateReviewGuide", outputSchema: prompt.outputSchema },
        "Model completion",
        reply,
      );
      return { revision, guide: normalizeReviewGuide(generated, change) };
    });

  return PullRequestGuideGeneration.of({ generate });
});

/** Needs a `ModelCompletion` layer supplied by the caller after folder and model authorization. */
export const layer = Layer.effect(PullRequestGuideGeneration, make);
