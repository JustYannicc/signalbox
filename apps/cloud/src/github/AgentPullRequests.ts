import { PR_IMAGE_LIMIT, type Request } from "@signalbox/runner-protocol/PullRequestTools";
import { ThreadId } from "@t3tools/contracts";
import { canWriteDrive } from "@t3tools/contracts/signalboxDrives";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";

import { DriveDirectory } from "../drive/DriveDirectory.ts";
import * as CloudThreadService from "../thread/CloudThreadService.ts";
import type { Actor } from "../thread/ThreadEngine.ts";
import * as UserDrives from "../user/UserDrives.ts";
import { driveOfProject, remoteThreadWorktree } from "../user/contextProjects.ts";
import { parseRepository } from "./GitHubApi.ts";
import * as GitHub from "./GitHub.ts";
import * as GitHubConnection from "./GitHubConnection.ts";
import {
  AgentPullRequestError,
  errorForCategory,
  isAgentPullRequestError,
  safeApiError,
} from "./agentPullRequestError.ts";
import {
  commentsOutput,
  createdCommentOutput,
  hasReviewComment,
  imageMatchesMime,
  isOwnedPullRequest,
  markdownImage,
  parseComments,
  parseJson,
  pullOutput,
  sanitizeUrl,
} from "./agentPullRequestOutput.ts";
import { makeAgentPullRequestReceipts } from "./agentPullRequestReceipts.ts";

export { AgentPullRequestError };

export class AgentPullRequests extends Context.Service<
  AgentPullRequests,
  {
    readonly execute: (
      threadId: string,
      request: Request,
    ) => Effect.Effect<unknown, AgentPullRequestError>;
  }
>()("@signalbox/cloud/github/AgentPullRequests") {}

export const layer = Layer.effect(
  AgentPullRequests,
  Effect.gen(function* () {
    const threads = yield* CloudThreadService.CloudThreadService;
    const drives = yield* UserDrives.UserDrives;
    const directory = yield* Effect.serviceOption(DriveDirectory);
    const connection = yield* GitHubConnection.GitHubConnection;
    const github = yield* GitHub.GitHub;
    const receipts = yield* makeAgentPullRequestReceipts(errorForCategory).pipe(Effect.orDie);

    const signedInActor = Effect.gen(function* () {
      const userId = yield* drives.userId;
      if (userId === null) return yield* errorForCategory("permission");
      const actor: Actor = { userId, contextIds: yield* drives.contextIds };
      return actor;
    });

    const targetFor = (threadId: string, actor: Actor, request: Request) =>
      Effect.gen(function* () {
        const snapshot = yield* threads
          .threadSnapshot(actor, ThreadId.make(threadId))
          .pipe(Effect.mapError(() => errorForCategory("permission")));
        const projection = snapshot.projection;
        const driveId = driveOfProject(projection.thread.projectId, actor.userId);
        if (driveId === null || directory._tag === "None")
          return yield* errorForCategory("permission");
        const role = yield* drives
          .access(driveId)
          .pipe(Effect.mapError(() => errorForCategory("permission")));
        if (!canWriteDrive(role)) return yield* errorForCategory("permission");
        const remote = yield* directory.value
          .forDrive(driveId)
          .remote()
          .pipe(Effect.mapError(() => errorForCategory("unavailable")));
        const repository =
          remote?.provider === "github" ? parseRepository(remote.repository) : null;
        if (repository === null) return yield* errorForCategory("permission");
        const branch = remoteThreadWorktree(driveId, ThreadId.make(threadId)).branch;
        const thread = projection.thread;
        const linked = thread.branchPullRequest ?? thread.linkedPullRequest ?? null;
        const number =
          request.number ??
          (linked?.repository === repository ? linked.number : undefined) ??
          thread.pullRequests?.find(
            (pull) => pull.repository === repository && pull.snapshot?.headBranch === branch,
          )?.number;
        return { number, branch, repository };
      });

    const pullFor = (
      token: string,
      target: {
        readonly number: number;
        readonly branch: string;
        readonly repository: string;
      },
    ) =>
      Effect.gen(function* () {
        const raw = yield* github.api
          .agentPull(token, target.repository, target.number)
          .pipe(Effect.mapError(safeApiError));
        if (raw === null) return yield* errorForCategory("not_found", 404);
        const pull = parseJson(raw);
        if (pull === null) return yield* errorForCategory("unavailable");
        if (
          !isOwnedPullRequest(pull, {
            number: target.number,
            repository: target.repository,
            branch: target.branch,
          })
        ) {
          return yield* errorForCategory("permission", 403);
        }
        return pull;
      });

    const commentsFor = (token: string, repository: string, number: number) =>
      Effect.gen(function* () {
        const text = yield* github.api
          .agentComments(token, repository, number)
          .pipe(Effect.mapError(safeApiError));
        const comments = parseComments(text);
        if (comments === null) return yield* errorForCategory("unavailable");
        return comments;
      });

    const resolveNumber = (
      token: string,
      target: {
        readonly number: number | undefined;
        readonly branch: string;
        readonly repository: string;
      },
    ) =>
      target.number !== undefined
        ? Effect.succeed(target.number)
        : github.api.pullForBranch(token, target.repository, target.branch).pipe(
            Effect.mapError(safeApiError),
            Effect.flatMap((pull) =>
              pull === null
                ? Effect.fail(errorForCategory("not_found"))
                : Effect.succeed(pull.number),
            ),
          );

    const executeInternal = (threadId: string, request: Request) =>
      Effect.gen(function* () {
        const actor = yield* signedInActor;
        const scope = yield* targetFor(threadId, actor, request);
        if (request._tag === "comment" || request._tag === "reply" || request._tag === "image") {
          const prior = yield* receipts.lookup(threadId, scope.repository, request);
          if (prior._tag === "replay") return prior.result;
        }
        const token = yield* connection.accessToken.pipe(
          Effect.mapError(() => errorForCategory("not_connected")),
        );
        if (token === null || token.trim() === "") return yield* errorForCategory("not_connected");
        const number = yield* resolveNumber(token, scope);
        const target = { ...scope, number };
        const pull = yield* pullFor(token, target);

        switch (request._tag) {
          case "read": {
            const comments = yield* commentsFor(token, target.repository, target.number);
            return {
              pullRequest: pullOutput(pull, token),
              comments: commentsOutput(comments, token),
            };
          }
          case "edit": {
            const edited = yield* github.api
              .agentEdit(token, target.repository, target.number, request.body)
              .pipe(Effect.mapError(safeApiError));
            if (edited === null) return yield* errorForCategory("not_found", 404);
            return { number: target.number, updated: true };
          }
          case "comment":
            return yield* receipts.run({
              threadId,
              repository: target.repository,
              operationId: request.operationId,
              request,
              write: () =>
                Effect.gen(function* () {
                  const response = yield* github.api
                    .agentComment(token, target.repository, target.number, request.body)
                    .pipe(Effect.mapError(safeApiError));
                  const comment = createdCommentOutput(response, token, false);
                  if (comment === null) return yield* errorForCategory("unavailable");
                  return { number: target.number, comment };
                }),
            });
          case "reply": {
            const comments = yield* commentsFor(token, target.repository, target.number);
            if (!hasReviewComment(comments, request.commentId))
              return yield* errorForCategory("permission", 403);
            return yield* receipts.run({
              threadId,
              repository: target.repository,
              operationId: request.operationId,
              request,
              write: () =>
                Effect.gen(function* () {
                  const response = yield* github.api
                    .agentReply(
                      token,
                      target.repository,
                      target.number,
                      String(request.commentId),
                      request.body,
                    )
                    .pipe(Effect.mapError(safeApiError));
                  const comment = createdCommentOutput(response, token, true);
                  if (comment === null) return yield* errorForCategory("unavailable");
                  return { number: target.number, comment };
                }),
            });
          }
          case "image": {
            const decoded = Base64.decode(request.base64);
            if (Result.isFailure(decoded)) return yield* errorForCategory("invalid");
            const bytes = decoded.success;
            if (
              bytes.byteLength === 0 ||
              bytes.byteLength > PR_IMAGE_LIMIT ||
              !imageMatchesMime(request.mimeType, bytes)
            ) {
              return yield* errorForCategory("invalid");
            }
            return yield* receipts.run({
              threadId,
              repository: target.repository,
              operationId: request.operationId,
              request,
              write: () =>
                Effect.gen(function* () {
                  const uploaded = yield* github.api
                    .agentImage(token, target.repository, request.name, request.mimeType, bytes)
                    .pipe(Effect.mapError(safeApiError));
                  if (uploaded === null || typeof uploaded.url !== "string")
                    return yield* errorForCategory("not_found", 404);
                  const url = sanitizeUrl(uploaded.url, token);
                  if (url === null) return yield* errorForCategory("unavailable");
                  return {
                    number: target.number,
                    url,
                    markdown: markdownImage(request.name, url),
                  };
                }),
            });
          }
        }
      });

    const execute: AgentPullRequests["Service"]["execute"] = (threadId, request) =>
      executeInternal(threadId, request).pipe(
        Effect.catch((error) =>
          isAgentPullRequestError(error)
            ? Effect.fail(error)
            : Effect.logWarning("agent pull request operation failed", {
                operation: request._tag,
              }).pipe(Effect.andThen(Effect.fail(errorForCategory("unavailable")))),
        ),
      );

    return AgentPullRequests.of({ execute });
  }),
);
