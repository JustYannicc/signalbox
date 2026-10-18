import {
  PullRequestOperationError,
  PullRequestOperationId,
  PullRequestReviewHeadSha,
  type PullRequestDetail,
  type PullRequestActivity,
  type PullRequestDiffInput,
  type PullRequestDiffResult,
  type PullRequestGenerateReviewGuideInput,
  type PullRequestInvalidateInput,
  type PullRequestRef,
  type PullRequestReviewGuideResult,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ModelCompletionError } from "../models/ModelCompletion.ts";
import * as UserModelSettings from "../user/UserModelSettings.ts";
import type { PullRequestReadError } from "./CloudPullRequestsService.ts";
import * as PullRequestGuideGeneration from "./PullRequestGuideGeneration.ts";
import { makePullRequestGuideContext } from "./PullRequestGuideContext.ts";
import { makePullRequestGuideStore } from "./PullRequestGuideStore.ts";
import {
  PullRequestRepository,
  type ResolvedPullRequestRepository,
} from "./PullRequestRepository.ts";

export class PullRequestGuideAlarm extends Context.Service<
  PullRequestGuideAlarm,
  { readonly armBy: (at: number) => Effect.Effect<void> }
>()("@signalbox/cloud/github/PullRequestReviewGuides/PullRequestGuideAlarm") {}

const iso = (at: number) => DateTime.formatIso(DateTime.makeUnsafe(at));
const failure = (
  reason: "conflict" | "operation-conflict" | "permission" | "not-connected",
  detail: string,
) => new PullRequestOperationError({ operation: "generateReviewGuide", reason, detail });
const storeError = (cause: unknown) =>
  new PullRequestOperationError({
    operation: "reviewGuide",
    detail: "Could not read or save the review guide.",
    cause,
  });
const isOperationError = Schema.is(PullRequestOperationError);
const isGenerationError = Schema.is(PullRequestGuideGeneration.PullRequestGuideGenerationError);
const isCompletionError = Schema.is(ModelCompletionError);
const encodeScope = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Tuple([
      Schema.String,
      Schema.String,
      Schema.String,
      Schema.Number,
      Schema.String,
      Schema.String,
    ]),
  ),
);
const encodeRequest = Schema.encodeSync(
  Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String])),
);
const isOperationId = Schema.is(PullRequestOperationId);
const isHead = Schema.is(PullRequestReviewHeadSha);

export const makePullRequestReviewGuides = (reads: {
  readonly detail: (
    input: PullRequestRef,
  ) => Effect.Effect<PullRequestDetail, PullRequestReadError>;
  readonly activity: (
    input: PullRequestRef,
  ) => Effect.Effect<PullRequestActivity, PullRequestReadError>;
  readonly diff: (
    input: PullRequestDiffInput,
  ) => Effect.Effect<PullRequestDiffResult, PullRequestReadError>;
  readonly invalidate: (input: PullRequestInvalidateInput) => Effect.Effect<void>;
}) =>
  Effect.gen(function* () {
    const repositories = yield* PullRequestRepository;
    const settings = yield* UserModelSettings.UserModelSettings;
    const generator = yield* PullRequestGuideGeneration.PullRequestGuideGeneration;
    const alarm = yield* PullRequestGuideAlarm;
    const store = yield* makePullRequestGuideStore;
    const guideContext = yield* makePullRequestGuideContext;

    const scopeOf = (target: ResolvedPullRequestRepository, input: PullRequestRef) =>
      encodeScope([
        input.projectId,
        target.host,
        target.repository.toLowerCase(),
        input.number,
        target.accountId,
        target.viewer.toLowerCase(),
      ]);
    const canonical = (
      target: ResolvedPullRequestRepository,
      input: PullRequestRef,
    ): PullRequestRef => ({
      projectId: input.projectId,
      host: target.host,
      repository: target.repository,
      number: input.number,
    });
    const requestOf = (scope: string, headSha: string) => encodeRequest([scope, headSha]);
    const arm = Effect.flatMap(store.nextWake, (at) =>
      at === null ? Effect.void : alarm.armBy(at),
    );

    const snapshot = (scope: string, currentHeadSha: string | null) =>
      store.snapshot(scope).pipe(
        Effect.map(({ guide, latest }): PullRequestReviewGuideResult => ({
          guide,
          currentHeadSha,
          run:
            latest === null || latest.status === "finished"
              ? null
              : latest.status === "failed"
                ? {
                    _tag: "Failed",
                    headSha: latest.head_sha,
                    failedAt: iso(latest.finished_at ?? latest.created_at),
                    detail: latest.detail ?? "The review guide could not be written.",
                  }
                : { _tag: "Running", headSha: latest.head_sha, startedAt: iso(latest.created_at) },
        })),
        Effect.mapError(storeError),
      );

    const reviewGuide = (input: PullRequestRef) =>
      Effect.gen(function* () {
        const target = yield* repositories.resolve(input);
        const detail = yield* reads.detail(input);
        return yield* snapshot(scopeOf(target, input), detail.headSha ?? null);
      });

    const generateReviewGuide = (input: PullRequestGenerateReviewGuideInput) =>
      Effect.gen(function* () {
        const target = yield* repositories.resolve(input);
        if (!isOperationId(input.operationId) || !isHead(input.headSha)) {
          return yield* failure(
            "conflict",
            "Provide an operation ID and the head SHA being reviewed.",
          );
        }
        const scope = scopeOf(target, input);
        const request = requestOf(scope, input.headSha);
        const receipt = yield* store
          .lookup(input.operationId, request)
          .pipe(Effect.mapError(storeError));
        if (receipt._tag === "conflict")
          return yield* failure(
            "operation-conflict",
            "This operation ID belongs to another guide request.",
          );
        if (receipt._tag === "replay") {
          yield* arm.pipe(Effect.mapError(storeError));
          return yield* reviewGuide(input);
        }
        const preference = yield* settings.snapshot.pipe(Effect.mapError(storeError));
        if (!preference.reviewGuidesEnabled) {
          return yield* failure(
            "permission",
            "Review guides are off. Turn them on in Settings → Source Control.",
          );
        }
        const detail = yield* reads.detail(input);
        if (detail.headSha !== input.headSha)
          return yield* failure(
            "conflict",
            "The pull request changed before guide generation started. Try again.",
          );
        // Arm before the durable claim so termination after its commit still has a wake-up.
        yield* alarm.armBy(yield* Clock.currentTimeMillis);
        yield* store
          .claim({
            operationId: input.operationId,
            request,
            scope,
            reference: canonical(target, input),
            accountId: target.accountId,
            headSha: input.headSha,
            now: yield* Clock.currentTimeMillis,
          })
          .pipe(
            Effect.flatMap((claim) =>
              claim._tag === "conflict"
                ? Effect.fail(
                    failure(
                      "operation-conflict",
                      "This operation ID belongs to another guide request.",
                    ),
                  )
                : Effect.void,
            ),
            Effect.mapError((cause) => (isOperationError(cause) ? cause : storeError(cause))),
          );
        yield* arm.pipe(Effect.mapError(storeError));
        yield* reads.invalidate({ reference: input });
        return yield* snapshot(scope, input.headSha);
      });

    const generate = (reference: PullRequestRef, headSha: string, accountId: string) =>
      Effect.gen(function* () {
        const target = yield* repositories.resolve(reference);
        if (target.accountId !== accountId)
          return yield* failure(
            "permission",
            "The connected GitHub account changed before guide generation.",
          );
        const context = yield* guideContext(reference.projectId);
        const detail = yield* reads.detail(reference);
        if (detail.headSha !== headSha)
          return yield* failure(
            "conflict",
            "The pull request changed before the guide could be written.",
          );
        const activity = yield* reads.activity(reference);
        const generated = yield* generator.generate({
          detail,
          activity,
          ...context,
          readDiff: (cursor) =>
            reads.diff({ ...reference, ...(cursor === undefined ? {} : { cursor }) }),
        });
        // Authority may change while the model runs. Never publish the result under a new account.
        const current = yield* repositories.resolve(reference);
        if (current.accountId !== accountId)
          return yield* failure(
            "permission",
            "The connected GitHub account changed during guide generation.",
          );
        return {
          headSha: generated.revision.headSha,
          generatedAt: iso(yield* Clock.currentTimeMillis),
          modelSelection: context.modelSelection,
          ...generated.guide,
        };
      });

    const wakeReviewGuides = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const expired = yield* store.expire(now).pipe(Effect.mapError(storeError));
      yield* Effect.forEach(expired, (reference) => reads.invalidate({ reference }), {
        discard: true,
      });
      const job = yield* store.startNext(now + 12 * 60_000).pipe(Effect.mapError(storeError));
      yield* arm.pipe(Effect.mapError(storeError));
      if (job === null) return;
      // The durable claim and recovery alarm precede detachment. A slow model must not hold
      // the person's session expiry, automation crons or other alarm work until it finishes.
      yield* Effect.forkDetach(
        Effect.gen(function* () {
          yield* generate(job.reference, job.head_sha, job.account_id).pipe(
            Effect.timeout("10 minutes"),
            Effect.matchEffect({
              onSuccess: (guide) =>
                Effect.flatMap(Clock.currentTimeMillis, (at) =>
                  store.finish(job.id, guide, at),
                ).pipe(Effect.mapError(storeError)),
              onFailure: (cause) =>
                Effect.flatMap(Clock.currentTimeMillis, (at) =>
                  store.fail(
                    job.id,
                    isOperationError(cause)
                      ? cause.detail
                      : isGenerationError(cause) || isCompletionError(cause)
                        ? cause.reason
                        : "The review guide could not be written. Generate it again.",
                    at,
                  ),
                ).pipe(Effect.mapError(storeError)),
            }),
          );
          yield* reads.invalidate({ reference: job.reference });
          yield* arm.pipe(Effect.mapError(storeError));
        }).pipe(
          Effect.catchCause((cause) => Effect.logError("review guide job failed", { cause })),
        ),
      );
    });
    yield* arm;
    return { reviewGuide, generateReviewGuide, wakeReviewGuides };
  });
