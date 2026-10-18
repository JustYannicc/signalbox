import {
  PullRequestOperationError,
  type PullRequestInvalidateInput,
  type PullRequestRef,
  type PullRequestThreadReplyInput,
  type PullRequestThreadResolutionInput,
} from "@t3tools/contracts";
import { canWriteDrive } from "@t3tools/contracts/signalboxDrives";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { driveOfProject } from "../user/contextProjects.ts";
import { UserDrives } from "../user/UserDrives.ts";
import { GitHub } from "./GitHub.ts";
import { PullRequestRepository } from "./PullRequestRepository.ts";
import { AgentPullRequestError, safeApiError } from "./agentPullRequestError.ts";
import { makeAgentPullRequestReceipts } from "./agentPullRequestReceipts.ts";

const THREAD = `query CollaborationThread($id: ID!) {
  node(id: $id) { ... on PullRequestReviewThread {
    id isResolved viewerCanReply viewerCanResolve viewerCanUnresolve
    pullRequest { number repository { nameWithOwner } }
  } }
}`;
const REPLY = `mutation CollaborationReply($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $threadId, body: $body}) {
    comment { id }
  }
}`;
const RESOLVE = `mutation CollaborationResolve($id: ID!) {
  resolveReviewThread(input: {threadId: $id}) { thread { id isResolved } }
}`;
const UNRESOLVE = `mutation CollaborationUnresolve($id: ID!) {
  unresolveReviewThread(input: {threadId: $id}) { thread { id isResolved } }
}`;
const Thread = Schema.Struct({
  id: Schema.String,
  isResolved: Schema.Boolean,
  viewerCanReply: Schema.Boolean,
  viewerCanResolve: Schema.Boolean,
  viewerCanUnresolve: Schema.Boolean,
  pullRequest: Schema.Struct({
    number: Schema.Number,
    repository: Schema.Struct({ nameWithOwner: Schema.String }),
  }),
});
const ThreadResult = Schema.Struct({ node: Schema.NullOr(Thread) });
const ReplyResult = Schema.Struct({
  addPullRequestReviewThreadReply: Schema.NullOr(
    Schema.Struct({ comment: Schema.NullOr(Schema.Struct({ id: Schema.String })) }),
  ),
});
const Resolution = Schema.NullOr(
  Schema.Struct({
    thread: Schema.NullOr(Schema.Struct({ id: Schema.String, isResolved: Schema.Boolean })),
  }),
);
const ResolutionResult = Schema.Struct({
  resolveReviewThread: Schema.optional(Resolution),
  unresolveReviewThread: Schema.optional(Resolution),
});

interface GraphqlAnswer<A> {
  readonly data?: A | null | undefined;
  readonly errors?: ReadonlyArray<{ readonly type?: string | undefined }> | undefined;
}
const answerOf = <A>(schema: Schema.Codec<A, unknown>) =>
  Schema.decodeUnknownOption(
    Schema.fromJsonString(
      Schema.Struct({
        data: Schema.optional(Schema.NullOr(schema)),
        errors: Schema.optional(
          Schema.Array(Schema.Struct({ type: Schema.optional(Schema.String) })),
        ),
      }),
    ),
  );
const decodeThread = answerOf(ThreadResult);
const decodeReply = answerOf(ReplyResult);
const decodeResolution = answerOf(ResolutionResult);

const refuse = AgentPullRequestError.forCategory;
const publicError = (operation: string) => (error: AgentPullRequestError) =>
  new PullRequestOperationError({
    operation,
    detail: error.message,
    status: error.status,
    ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }),
    reason:
      error.retryAt !== undefined
        ? "rate-limit"
        : error.category === "not_found"
          ? "not-found"
          : error.category === "not_connected"
            ? "not-connected"
            : error.category === "conflict"
              ? "operation-conflict"
              : error.category === "github_conflict"
                ? "conflict"
                : error.category === "unavailable"
                  ? undefined
                  : error.category,
  });

/** Folder authority is checked anew even when a durable receipt can answer the retry. */
export const makePullRequestCollaboration = (
  invalidate: (input: PullRequestInvalidateInput) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    const repositories = yield* PullRequestRepository;
    const drives = yield* UserDrives;
    const receipts = yield* makeAgentPullRequestReceipts(refuse);

    const authorize = (input: PullRequestRef) =>
      Effect.gen(function* () {
        const target = yield* repositories.resolve(input);
        const userId = yield* drives.userId.pipe(Effect.mapError(() => refuse("permission")));
        const driveId = userId === null ? null : driveOfProject(input.projectId, userId);
        if (driveId === null) return yield* refuse("permission");
        const role = yield* drives
          .access(driveId)
          .pipe(Effect.mapError(() => refuse("permission")));
        if (!canWriteDrive(role)) return yield* refuse("permission");
        return target;
      });

    const query = <A>(
      token: string,
      document: string,
      variables: Readonly<Record<string, unknown>>,
      decode: (text: string) => Option.Option<GraphqlAnswer<A>>,
    ) =>
      Effect.gen(function* () {
        const text = yield* github.api
          .graphql("pullRequestCollaboration", token, document, variables)
          .pipe(
            Effect.mapError((error) =>
              // GraphQL reports a definite rate-limit refusal inside an HTTP 200.
              safeApiError(error.retryAt === undefined ? error : { ...error, status: 429 }),
            ),
          );
        if (text === null) return yield* refuse("not_found", 404);
        const decoded = decode(text);
        if (Option.isNone(decoded)) return yield* refuse("unavailable", 200);
        const { data, errors } = decoded.value;
        if (errors !== undefined && errors.length > 0) {
          // A mutation may have committed before one of its selected fields failed.
          if (
            data != null &&
            typeof data === "object" &&
            Object.values(data).some((value) => value != null)
          )
            return yield* refuse("unavailable", 200);
          const types = errors.map((error) => error.type);
          if (types.every((type) => type === "FORBIDDEN")) return yield* refuse("permission", 403);
          if (types.every((type) => type === "NOT_FOUND")) return yield* refuse("not_found", 404);
          if (types.every((type) => type === "UNPROCESSABLE"))
            return yield* refuse("github_conflict", 422);
          return yield* refuse("unavailable", 200);
        }
        if (data == null) return yield* refuse("unavailable", 200);
        return data;
      });

    const threadFor = (
      input: PullRequestThreadResolutionInput | PullRequestThreadReplyInput,
      token: string,
      repository: string,
    ) =>
      Effect.gen(function* () {
        const { node } = yield* query(token, THREAD, { id: input.threadId }, decodeThread);
        if (node === null) return yield* refuse("not_found", 404);
        if (
          node.pullRequest.number !== input.number ||
          node.pullRequest.repository.nameWithOwner.toLowerCase() !== repository.toLowerCase()
        )
          return yield* refuse("permission", 403);
        return node;
      });

    const replyToThread = (input: PullRequestThreadReplyInput) =>
      Effect.gen(function* () {
        if (input.body.trim().length === 0 || !input.operationId) return yield* refuse("invalid");
        const target = yield* authorize(input);
        const thread = yield* threadFor(input, target.token, target.repository);
        if (!thread.viewerCanReply) return yield* refuse("permission", 403);
        yield* receipts
          .run({
            threadId: `public-pr:${input.projectId}`,
            repository: target.repository.toLowerCase(),
            operationId: input.operationId,
            request: {
              operation: "replyToThread",
              host: target.host,
              accountId: target.accountId,
              number: input.number,
              threadId: input.threadId,
              body: input.body,
            },
            write: () =>
              query(
                target.token,
                REPLY,
                { threadId: input.threadId, body: input.body },
                decodeReply,
              ).pipe(
                Effect.flatMap((result) => {
                  const id = result.addPullRequestReviewThreadReply?.comment?.id;
                  return id === undefined
                    ? Effect.fail(refuse("unavailable", 200))
                    : Effect.succeed({ providerId: id });
                }),
              ),
          })
          .pipe(
            Effect.mapError((error) => (error._tag === "SqlError" ? refuse("unavailable") : error)),
          );
        yield* invalidate({ reference: input });
      }).pipe(
        Effect.catchTags({
          AgentPullRequestError: (error) => Effect.fail(publicError("replyToThread")(error)),
        }),
      );

    const setThreadResolution = (input: PullRequestThreadResolutionInput) =>
      Effect.gen(function* () {
        const target = yield* authorize(input);
        const thread = yield* threadFor(input, target.token, target.repository);
        if (thread.isResolved !== input.resolved) {
          if (!(input.resolved ? thread.viewerCanResolve : thread.viewerCanUnresolve))
            return yield* refuse("permission", 403);
          const result = yield* query(
            target.token,
            input.resolved ? RESOLVE : UNRESOLVE,
            { id: input.threadId },
            decodeResolution,
          );
          const updated = (
            input.resolved ? result.resolveReviewThread : result.unresolveReviewThread
          )?.thread;
          if (updated?.id !== input.threadId || updated.isResolved !== input.resolved)
            return yield* refuse("github_conflict");
        }
        yield* invalidate({ reference: input });
      }).pipe(
        Effect.catchTags({
          AgentPullRequestError: (error) => Effect.fail(publicError("setThreadResolution")(error)),
        }),
      );

    return { replyToThread, setThreadResolution };
  });
