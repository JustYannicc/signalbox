import { PullRequestOperationError } from "@t3tools/contracts";
import type { SignalboxDriveRole } from "@t3tools/contracts/signalboxDrives";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as Environment from "../environment.ts";
import * as Platform from "../platform.ts";
import { UserDrives } from "../user/UserDrives.ts";
import { GitHub } from "./GitHub.ts";
import { GitHubError, type GitHubApi } from "./GitHubApi.ts";
import { PullRequestRepository } from "./PullRequestRepository.ts";
import { makePullRequestCollaboration } from "./PullRequestCollaboration.ts";

const reference = { projectId: Environment.scratchProject.id, repository: "acme/web", number: 12 };
const reply = { ...reference, threadId: "PRRT_1", body: "Fixed.", operationId: "reply-1" };
const resolution = { ...reference, threadId: "PRRT_1", resolved: true };

const fixture = Effect.gen(function* () {
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
          return JSON.stringify({
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
        if (state.malformed) return JSON.stringify({ data: {} });
        if (state.errors !== undefined) return JSON.stringify({ data: null, errors: state.errors });
        if (document.includes("CollaborationReply"))
          return JSON.stringify({
            data: { addPullRequestReviewThreadReply: { comment: { id: "PRRC_created" } } },
          });
        state.resolved = !document.includes("CollaborationUnresolve");
        const key = state.resolved ? "resolveReviewThread" : "unresolveReviewThread";
        return JSON.stringify({
          data: { [key]: { thread: { id: "PRRT_1", isResolved: state.resolved } } },
        });
      }),
  } as unknown as GitHubApi;
  const dependencies = Layer.mergeAll(
    Layer.succeed(GitHub, GitHub.of({ pipes: null, api })),
    Layer.mock(PullRequestRepository, {
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
  return { state, make, writes: yield* make, sql: yield* SqlClient.SqlClient };
});
const storage = Layer.mergeAll(
  NodeSqliteClient.layer({ filename: ":memory:" }),
  Platform.layerCrypto,
);
const failure = (status: number, retryAt?: number) =>
  new GitHubError({
    operation: "reply",
    status,
    message: "provider-secret",
    ...(retryAt === undefined ? {} : { retryAt }),
  });

describe("cloud PR collaboration", () => {
  it.effect("persists the provider id and replays across service reconstruction", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.writes.replyToThread(reply);
      const restarted = yield* f.make;
      yield* restarted.replyToThread(reply);
      expect(f.state.writes).toBe(1);
      expect(f.state.refreshes).toBe(2);
      const [receipt] = yield* f.sql<{
        status: string;
        result: string;
      }>`SELECT status, result FROM agent_pull_request_operations`;
      expect(receipt).toEqual({
        status: "finished",
        result: JSON.stringify({ providerId: "PRRC_created" }),
      });
      expect(f.state.tokens.every((token) => token === "token-123")).toBe(true);
    }).pipe(Effect.provide(storage)),
  );

  it.effect("rejects operation id reuse for different content or another GitHub identity", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.writes.replyToThread(reply);
      expect(
        yield* f.writes.replyToThread({ ...reply, body: "Different." }).pipe(Effect.flip),
      ).toMatchObject({ reason: "conflict" });
      f.state.accountId = "456";
      f.state.token = "token-456";
      expect(yield* f.writes.replyToThread(reply).pipe(Effect.flip)).toMatchObject({
        reason: "conflict",
      });
      expect(f.state.writes).toBe(1);
    }).pipe(Effect.provide(storage)),
  );

  it.effect("never resends an ambiguous write after a lost response", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.state.failure = failure(0);
      const first = yield* f.writes.replyToThread(reply).pipe(Effect.flip);
      expect(first.message).not.toContain("provider-secret");
      f.state.failure = null;
      const restarted = yield* f.make;
      expect(yield* restarted.replyToThread(reply).pipe(Effect.flip)).toMatchObject({
        reason: "pending",
      });
      expect(f.state.writes).toBe(1);
      expect(f.state.refreshes).toBe(0);
    }).pipe(Effect.provide(storage)),
  );

  it.effect("claims a concurrent retry before allowing a second provider write", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      f.state.afterWrite = Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      );
      const first = yield* f.writes.replyToThread(reply).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      expect(yield* f.writes.replyToThread(reply).pipe(Effect.flip)).toMatchObject({
        reason: "pending",
      });
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
      expect(f.state.writes).toBe(1);
    }).pipe(Effect.provide(storage)),
  );

  it.effect("preserves typed rate limits and permits retry after a definite refusal", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.state.failure = failure(429, 1_234_567);
      const error = yield* f.writes.replyToThread(reply).pipe(Effect.flip);
      expect(error).toMatchObject({ reason: "rate-limit", status: 429, retryAt: 1_234_567 });
      const encoded = JSON.parse(JSON.stringify(error));
      expect(PullRequestOperationError.make(encoded)).toMatchObject({ retryAt: 1_234_567 });
      f.state.failure = null;
      yield* f.writes.replyToThread(reply);
      expect(f.state.writes).toBe(2);
    }).pipe(Effect.provide(storage)),
  );

  it.effect("rechecks revoked folder access before replaying a completed operation", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.writes.replyToThread(reply);
      for (const role of ["viewer", null] as const) {
        f.state.role = role;
        expect(yield* f.writes.replyToThread(reply).pipe(Effect.flip)).toMatchObject({
          reason: "permission",
        });
        expect(yield* f.writes.setThreadResolution(resolution).pipe(Effect.flip)).toMatchObject({
          reason: "permission",
        });
      }
      expect(f.state.writes).toBe(1);
    }).pipe(Effect.provide(storage)),
  );

  it.effect("rejects a thread from another pull request or repository", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.state.number = 13;
      expect(yield* f.writes.replyToThread(reply).pipe(Effect.flip)).toMatchObject({
        reason: "permission",
      });
      f.state.number = 12;
      f.state.repository = "acme/private";
      expect(yield* f.writes.setThreadResolution(resolution).pipe(Effect.flip)).toMatchObject({
        reason: "permission",
      });
      expect(f.state.writes).toBe(0);
    }).pipe(Effect.provide(storage)),
  );

  it.effect("rejects missing operation ids, empty replies and denied thread authority", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      expect(
        yield* f.writes.replyToThread({ ...reply, operationId: undefined }).pipe(Effect.flip),
      ).toMatchObject({ reason: "invalid" });
      expect(
        yield* f.writes.replyToThread({ ...reply, body: "  " }).pipe(Effect.flip),
      ).toMatchObject({ reason: "invalid" });
      f.state.canReply = false;
      f.state.canResolve = false;
      expect(yield* f.writes.replyToThread(reply).pipe(Effect.flip)).toMatchObject({
        reason: "permission",
      });
      expect(yield* f.writes.setThreadResolution(resolution).pipe(Effect.flip)).toMatchObject({
        reason: "permission",
      });
      expect(f.state.writes).toBe(0);
    }).pipe(Effect.provide(storage)),
  );

  it.effect("resolves, safely repeats and reopens with the acting identity", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.writes.setThreadResolution(resolution);
      yield* f.writes.setThreadResolution(resolution);
      expect(f.state.writes).toBe(1);
      f.state.canUnresolve = false;
      expect(
        yield* f.writes.setThreadResolution({ ...resolution, resolved: false }).pipe(Effect.flip),
      ).toMatchObject({ reason: "permission" });
      f.state.canUnresolve = true;
      yield* f.writes.setThreadResolution({ ...resolution, resolved: false });
      expect(f.state.resolved).toBe(false);
      expect(f.state.refreshes).toBe(3);
      expect(f.state.writes).toBe(2);
    }).pipe(Effect.provide(storage)),
  );

  it.effect("does not turn partial or forbidden GraphQL answers into success", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.state.malformed = true;
      yield* f.writes.replyToThread(reply).pipe(Effect.flip);
      expect(yield* f.writes.replyToThread(reply).pipe(Effect.flip)).toMatchObject({
        reason: "pending",
      });
      f.state.malformed = false;
      f.state.errors = [{ type: "FORBIDDEN" }];
      expect(
        yield* f.writes.replyToThread({ ...reply, operationId: "forbidden" }).pipe(Effect.flip),
      ).toMatchObject({ reason: "permission", status: 403 });
      expect(f.state.refreshes).toBe(0);
    }).pipe(Effect.provide(storage)),
  );
});
