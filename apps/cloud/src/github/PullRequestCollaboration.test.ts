import { PullRequestOperationError } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { fixture, reply, resolution, storage, failure } from "./pullRequestCollaborationTesting.ts";

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
      ).toMatchObject({ reason: "operation-conflict" });
      f.state.accountId = "456";
      f.state.token = "token-456";
      expect(yield* f.writes.replyToThread(reply).pipe(Effect.flip)).toMatchObject({
        reason: "operation-conflict",
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

  it.effect("retries the same operation after a GraphQL HTTP-200 rate-limit refusal", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.state.failure = failure(200, 1_234_567);
      expect(yield* f.writes.replyToThread(reply).pipe(Effect.flip)).toMatchObject({
        reason: "rate-limit",
        status: 429,
        retryAt: 1_234_567,
      });
      f.state.failure = null;
      yield* f.writes.replyToThread(reply);
      yield* f.writes.replyToThread(reply);
      expect(f.state.writes).toBe(2);
    }).pipe(Effect.provide(storage)),
  );

  it.effect("distinguishes reconnecting, provider conflicts and operation id conflicts", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.state.failure = failure(401);
      expect(yield* f.writes.replyToThread(reply).pipe(Effect.flip)).toMatchObject({
        reason: "not-connected",
      });
      f.state.failure = failure(422);
      expect(yield* f.writes.replyToThread(reply).pipe(Effect.flip)).toMatchObject({
        reason: "conflict",
      });
      f.state.failure = null;
      yield* f.writes.replyToThread(reply);
      expect(
        yield* f.writes.replyToThread({ ...reply, body: "Changed" }).pipe(Effect.flip),
      ).toMatchObject({ reason: "operation-conflict" });
    }).pipe(Effect.provide(storage)),
  );

  it.effect("keeps partial GraphQL mutation results pending despite errors", () =>
    Effect.gen(function* () {
      for (const type of ["FORBIDDEN", "RATE_LIMITED"]) {
        const f = yield* fixture;
        const input = { ...reply, operationId: `partial-${type}` };
        f.state.partial = true;
        f.state.errors = [{ type }];
        yield* f.writes.replyToThread(input).pipe(Effect.flip);
        f.state.errors = undefined;
        expect(yield* f.writes.replyToThread(input).pipe(Effect.flip)).toMatchObject({
          reason: "pending",
        });
        expect(f.state.writes).toBe(1);
      }
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
