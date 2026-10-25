import {
  type PullRequestInvalidateInput,
  type PullRequestThreadReplyInput,
  type PullRequestThreadResolutionInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { GitHub } from "./GitHub.ts";
import { AgentPullRequestError } from "./agentPullRequestError.ts";
import { makeAgentPullRequestReceipts } from "./agentPullRequestReceipts.ts";
import {
  collaborationError,
  makeCollaborationQuery,
  makePullRequestWriteAccess,
} from "./pullRequestCollaborationSupport.ts";

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

const refuse = AgentPullRequestError.forCategory;

export const makePullRequestCollaboration = (
  invalidate: (input: PullRequestInvalidateInput) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    const authorize = yield* makePullRequestWriteAccess;
    const receipts = yield* makeAgentPullRequestReceipts(refuse);
    const query = makeCollaborationQuery(github.api);

    const threadFor = (
      input: PullRequestThreadResolutionInput | PullRequestThreadReplyInput,
      token: string,
      repository: string,
    ) =>
      Effect.gen(function* () {
        const { node } = yield* query(token, THREAD, { id: input.threadId }, ThreadResult);
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
                ReplyResult,
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
          AgentPullRequestError: (error) => Effect.fail(collaborationError("replyToThread")(error)),
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
            ResolutionResult,
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
          AgentPullRequestError: (error) =>
            Effect.fail(collaborationError("setThreadResolution")(error)),
        }),
      );

    return { replyToThread, setThreadResolution };
  });
