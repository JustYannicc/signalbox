import type {
  GitManagerError,
  GitPullRequestRefInput,
  GitResolvePullRequestResult,
  PullRequestActivity,
  PullRequestChecks,
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
  PullRequestRoutingIdentityInput,
  PullRequestRoutingIdentityResult,
  PullRequestRoutingResult,
  PullRequestStack,
  PullRequestSummary,
  PullRequestThreadReplyInput,
  PullRequestThreadResolutionInput,
  PullRequestThreadCommentsInput,
  PullRequestThreadCommentsResult,
  PullRequestUnavailableError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

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
    readonly setThreadResolution: (
      input: PullRequestThreadResolutionInput,
    ) => Effect.Effect<void, PullRequestReadError>;
    readonly invalidate: (input: PullRequestInvalidateInput) => Effect.Effect<void>;
    readonly subscribeRefreshes: Stream.Stream<number>;
    readonly resolvePullRequest: (
      input: GitPullRequestRefInput,
    ) => Effect.Effect<GitResolvePullRequestResult, GitManagerError>;
  }
>()("@signalbox/cloud/github/CloudPullRequestsService/CloudPullRequests") {}
