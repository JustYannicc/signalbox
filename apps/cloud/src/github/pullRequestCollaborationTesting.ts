import type { SignalboxDriveRole } from "@t3tools/contracts/signalboxDrives";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Environment from "../environment.ts";
import * as Platform from "../platform.ts";
import { UserDrives } from "../user/UserDrives.ts";
import { GitHub } from "./GitHub.ts";
import { GitHubError, type GitHubApi } from "./GitHubApi.ts";
import { PullRequestRepository } from "./PullRequestRepository.ts";
import { makePullRequestCollaboration } from "./PullRequestCollaboration.ts";

export const reference = {
  projectId: Environment.scratchProject.id,
  repository: "acme/web",
  number: 12,
};
export const reply = { ...reference, threadId: "PRRT_1", body: "Fixed.", operationId: "reply-1" };
export const resolution = { ...reference, threadId: "PRRT_1", resolved: true };
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export const fixture = Effect.gen(function* () {
  const state = {
    role: "owner" as SignalboxDriveRole | null,
    accountId: "123",
    token: "token-123",
    number: 12,
    repository: "acme/web",
    resolved: false,
    canReply: true,
    canResolve: true,
    canUnresolve: true,
    writes: 0,
    refreshes: 0,
    failure: null as GitHubError | null,
    malformed: false,
    partial: false,
    errors: undefined as ReadonlyArray<{ readonly type: string }> | undefined,
    afterWrite: Effect.void as Effect.Effect<void>,
    tokens: [] as Array<string>,
  };
  const api = {
    host: "github.com",
    graphql: (_operation: string, token: string, document: string) =>
      Effect.gen(function* () {
        state.tokens.push(token);
        if (document.startsWith("query"))
          return encodeJson({
            data: {
              node: {
                id: "PRRT_1",
                isResolved: state.resolved,
                viewerCanReply: state.canReply,
                viewerCanResolve: state.canResolve,
                viewerCanUnresolve: state.canUnresolve,
                pullRequest: {
                  number: state.number,
                  repository: { nameWithOwner: state.repository },
                },
              },
            },
          });
        state.writes += 1;
        yield* state.afterWrite;
        if (state.failure !== null) return yield* state.failure;
        if (state.malformed) return encodeJson({ data: {} });
        if (state.errors !== undefined)
          return encodeJson({
            data: state.partial
              ? { addPullRequestReviewThreadReply: { comment: { id: "PRRC_created" } } }
              : null,
            errors: state.errors,
          });
        if (document.includes("CollaborationReply"))
          return encodeJson({
            data: { addPullRequestReviewThreadReply: { comment: { id: "PRRC_created" } } },
          });
        state.resolved = !document.includes("CollaborationUnresolve");
        const key = state.resolved ? "resolveReviewThread" : "unresolveReviewThread";
        return encodeJson({
          data: { [key]: { thread: { id: "PRRT_1", isResolved: state.resolved } } },
        });
      }),
  } as unknown as GitHubApi;
  const dependencies = Layer.mergeAll(
    Layer.succeed(GitHub, GitHub.of({ pipesForUser: () => Effect.succeed(null), api })),
    Layer.mock(PullRequestRepository, {
      forProject: () =>
        Effect.succeed({
          project: Environment.scratchProject,
          repository: "acme/web",
          host: "github.com",
          token: state.token,
          viewer: "octocat",
          accountId: state.accountId,
        }),
      resolve: () =>
        Effect.succeed({
          project: { ...Environment.scratchProject, id: reference.projectId },
          repository: "acme/web",
          host: "github.com",
          token: state.token,
          viewer: "octocat",
          accountId: state.accountId,
        }),
    }),
    Layer.mock(UserDrives, {
      userId: Effect.succeed("user-1"),
      access: () => Effect.sync(() => state.role),
    }),
  );
  const make = makePullRequestCollaboration(() =>
    Effect.sync(() => {
      state.refreshes += 1;
    }),
  ).pipe(Effect.provide(dependencies));
  return { state, make, writes: yield* make, sql: yield* SqlClient.SqlClient, dependencies };
});
export const storage = Layer.mergeAll(
  NodeSqliteClient.layer({ filename: ":memory:" }),
  Platform.layerCrypto,
);
export const failure = (status: number, retryAt?: number) =>
  new GitHubError({
    operation: "reply",
    status,
    message: "provider-secret",
    ...(retryAt === undefined ? {} : { retryAt }),
  });
