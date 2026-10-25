import { type ToolResult } from "@signalbox/runner-protocol/AutomationProtocol";
import { Request } from "@signalbox/runner-protocol/PullRequestReviewTools";
import { PullRequestOperationError, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

import { CloudThreadService } from "../thread/CloudThreadService.ts";
import { UserDrives } from "../user/UserDrives.ts";
import { CloudPullRequests } from "./CloudPullRequestsService.ts";
import { PullRequestRepository } from "./PullRequestRepository.ts";

const decode = Schema.decodeUnknownEffect(Request, { onExcessProperty: "error" });
const denied = () =>
  new PullRequestOperationError({
    operation: "pullRequestReviewTool",
    reason: "permission",
    status: 403,
    detail: "You don't have access to this thread's folder.",
  });

/** The machine's authenticated thread supplies the folder and acting person. */
export const pullRequestReviewTool = (actorThreadId: string, raw: unknown) =>
  Effect.gen(function* () {
    const input = yield* decode(raw).pipe(
      Effect.mapError(
        () =>
          new PullRequestOperationError({
            operation: "pullRequestReviewTool",
            reason: "invalid",
            detail: "The review tool request is invalid.",
          }),
      ),
    );
    const drives = yield* Effect.serviceOption(UserDrives);
    const threads = yield* Effect.serviceOption(CloudThreadService);
    const repositories = yield* Effect.serviceOption(PullRequestRepository);
    const service = yield* Effect.serviceOption(CloudPullRequests);
    if (
      Option.isNone(drives) ||
      Option.isNone(threads) ||
      Option.isNone(repositories) ||
      Option.isNone(service)
    )
      return yield* new PullRequestOperationError({
        operation: "pullRequestReviewTool",
        detail: "Pull request review is unavailable in this cloud.",
      });
    const userId = yield* drives.value.userId;
    if (userId === null) return yield* denied();
    const actor = { userId, contextIds: yield* drives.value.contextIds };
    const snapshot = yield* threads.value
      .threadSnapshot(actor, ThreadId.make(actorThreadId))
      .pipe(Effect.mapError(denied));
    const projectId = snapshot.projection.thread.projectId;
    const target = yield* repositories.value.forProject(projectId);
    const reference = {
      projectId,
      host: target.host,
      repository: target.repository,
      expectedAccountId: target.accountId,
      number: input.number,
    };
    const pullRequests = service.value;
    switch (input.action) {
      case "read": {
        const [activity, detail] = yield* Effect.all([
          pullRequests.activity(reference),
          pullRequests.detail(reference),
        ]);
        return { ...activity, headSha: detail.headSha };
      }
      case "reply":
        yield* pullRequests.replyToThread({
          ...reference,
          threadId: input.threadId,
          body: input.body,
          operationId: input.operationId,
        });
        return { written: true };
      case "resolve":
        yield* pullRequests.setThreadResolution({
          ...reference,
          threadId: input.threadId,
          resolved: input.resolved,
        });
        return { written: true, resolved: input.resolved };
      case "comment":
        yield* pullRequests.comment({
          ...reference,
          body: input.body,
          operationId: input.operationId,
        });
        return { written: true };
      case "updateComment":
        yield* pullRequests.updateComment({
          ...reference,
          commentId: input.commentId,
          kind: input.kind,
          body: input.body,
        });
        return { written: true };
      case "submitReview":
        yield* pullRequests.submitReview({
          ...reference,
          operationId: input.operationId,
          headSha: input.headSha,
          verdict: input.verdict,
          body: input.body,
          comments: input.comments,
        });
        return { written: true };
      case "setReaction":
        yield* pullRequests.setReaction({
          ...reference,
          ...(input.subjectId === undefined ? {} : { subjectId: input.subjectId }),
          content: input.content,
          reacted: input.reacted,
        });
        return { written: true, reacted: input.reacted };
    }
  }).pipe(
    Effect.map((result): ToolResult => ({ _tag: "ok", result })),
    Effect.catchTags({
      PullRequestOperationError: (error) =>
        Effect.succeed<ToolResult>({
          _tag: "failed",
          message: error.message,
          error: {
            _tag: error._tag,
            operation: error.operation,
            detail: error.detail,
            ...(error.reason === undefined ? {} : { reason: error.reason }),
            ...(error.status === undefined ? {} : { status: error.status }),
            ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }),
          },
        }),
      PullRequestUnavailableError: (error) =>
        Effect.succeed<ToolResult>({
          _tag: "failed",
          message: error.message,
          error: { _tag: error._tag, reason: error.reason, provider: error.provider },
        }),
      SqlError: () =>
        Effect.succeed<ToolResult>({
          _tag: "failed",
          message: "Pull request review is unavailable right now.",
        }),
    }),
  );
