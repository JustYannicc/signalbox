import type {
  GitManagerError,
  GitPreparePullRequestThreadInput,
  GitPreparePullRequestThreadResult,
  GitPullRequestRefInput,
  GitResolvePullRequestResult,
  PullRequestActivity,
  PullRequestChecks,
  PullRequestCommentInput,
  PullRequestCommentUpdateInput,
  PullRequestDetail,
  PullRequestDiffFileContentsInput,
  PullRequestDiffFileContentsResult,
  PullRequestDiffInput,
  PullRequestDiffResult,
  PullRequestInvalidateInput,
  PullRequestLinkedThreadsResult,
  PullRequestListInput,
  PullRequestListResult,
  PullRequestListStatsInput,
  PullRequestListStatsResult,
  PullRequestOperationError,
  PullRequestPreview,
  PullRequestRef,
  PullRequestReactionInput,
  PullRequestRoutingIdentityInput,
  PullRequestRoutingIdentityResult,
  PullRequestRoutingResult,
  PullRequestStack,
  PullRequestSummary,
  PullRequestSubmitReviewInput,
  PullRequestThreadReplyInput,
  PullRequestThreadResolutionInput,
  PullRequestThreadCommentsInput,
  PullRequestThreadCommentsResult,
  PullRequestUnavailableError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type { Actor } from "../thread/ThreadAccess.ts";

export type PullRequestReadError = PullRequestUnavailableError | PullRequestOperationError;

export class CloudPullRequests extends Context.Service<
  CloudPullRequests,
  {
    readonly list: (
      input: PullRequestListInput,
    ) => Effect.Effect<PullRequestListResult, PullRequestReadError>;
    readonly listStats: (
      input: PullRequestListStatsInput,
    ) => Effect.Effect<PullRequestListStatsResult, PullRequestReadError>;
    readonly summary: (
      input: PullRequestRef,
    ) => Effect.Effect<PullRequestSummary, PullRequestReadError>;
    readonly detail: (
      input: PullRequestRef,
    ) => Effect.Effect<PullRequestDetail, PullRequestReadError>;
    readonly preview: (
      input: PullRequestRef,
    ) => Effect.Effect<PullRequestPreview, PullRequestReadError>;
    readonly checks: (
      input: PullRequestRef,
    ) => Effect.Effect<PullRequestChecks, PullRequestReadError>;
    readonly activity: (
      input: PullRequestRef,
    ) => Effect.Effect<PullRequestActivity, PullRequestReadError>;
    readonly stack: (
      input: PullRequestRef,
    ) => Effect.Effect<PullRequestStack | null, PullRequestReadError>;
    readonly linkedThreads: (
      input: PullRequestRef,
    ) => Effect.Effect<PullRequestLinkedThreadsResult, PullRequestReadError>;
    readonly threadComments: (
      input: PullRequestThreadCommentsInput,
    ) => Effect.Effect<PullRequestThreadCommentsResult, PullRequestReadError>;
    readonly diff: (
      input: PullRequestDiffInput,
    ) => Effect.Effect<PullRequestDiffResult, PullRequestReadError>;
    readonly diffFileContents: (
      input: PullRequestDiffFileContentsInput,
    ) => Effect.Effect<PullRequestDiffFileContentsResult, PullRequestReadError>;
    readonly routing: (
      input: PullRequestRef,
    ) => Effect.Effect<PullRequestRoutingResult, PullRequestReadError>;
    readonly routingIdentity: (
      input: PullRequestRoutingIdentityInput,
    ) => Effect.Effect<PullRequestRoutingIdentityResult, PullRequestReadError>;
    readonly replyToThread: (
      input: PullRequestThreadReplyInput,
    ) => Effect.Effect<void, PullRequestReadError>;
    readonly comment: (input: PullRequestCommentInput) => Effect.Effect<void, PullRequestReadError>;
    readonly updateComment: (
      input: PullRequestCommentUpdateInput,
    ) => Effect.Effect<void, PullRequestReadError>;
    readonly submitReview: (
      input: PullRequestSubmitReviewInput,
    ) => Effect.Effect<void, PullRequestReadError>;
    readonly setReaction: (
      input: PullRequestReactionInput,
    ) => Effect.Effect<void, PullRequestReadError>;
    readonly setThreadResolution: (
      input: PullRequestThreadResolutionInput,
    ) => Effect.Effect<void, PullRequestReadError>;
    readonly invalidate: (input: PullRequestInvalidateInput) => Effect.Effect<void>;
    readonly subscribeRefreshes: Stream.Stream<number>;
    readonly resolvePullRequest: (
      input: GitPullRequestRefInput,
    ) => Effect.Effect<GitResolvePullRequestResult, GitManagerError>;
    readonly preparePullRequestThread: (
      actor: Actor,
      input: GitPreparePullRequestThreadInput,
    ) => Effect.Effect<GitPreparePullRequestThreadResult, GitManagerError>;
  }
>()("@signalbox/cloud/github/CloudPullRequestsService/CloudPullRequests") {}
