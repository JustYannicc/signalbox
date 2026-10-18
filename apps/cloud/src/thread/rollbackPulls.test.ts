import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { remoteThreadWorktree } from "../user/contextProjects.ts";
import * as PullState from "./PullState.ts";
import * as ThreadPulls from "./ThreadPulls.ts";
import * as ThreadStore from "./ThreadStore.ts";
import { firstCommit, finish, fixture, undo } from "./rollbackTesting.ts";
import {
  connect,
  freshDatabase,
  launch,
  owner,
  personal,
  threadId,
  withObject,
} from "./runnerTesting.ts";

const driveId = personal.place.driveId;
const worktree = remoteThreadWorktree(driveId, threadId);
const operation = {
  id: "pull",
  target: firstCommit,
  expectedThread: firstCommit,
  expectedWip: firstCommit,
  revision: null,
  branch: worktree.branch,
};

describe("undo and Git operation admission", () => {
  it.effect.each(["pull", "publication"] as const)(
    "waits for a pending %s without recording a permanent undo rejection",
    (kind) => {
      const f = fixture();
      return withObject(
        freshDatabase(),
        (engine, runner, context) =>
          Effect.gen(function* () {
            yield* launch(engine);
            const machine = yield* connect(runner);
            const first = yield* finish(
              runner,
              machine.generation,
              1,
              f,
              firstCommit,
              null,
              "answer",
            );
            const state = Context.get(context, PullState.PullState);
            const store = Context.get(context, ThreadStore.ThreadStore);
            if (kind === "pull") {
              yield* state.insert({ actorId: owner.userId, driveId, operation });
            } else {
              yield* state.reservePublication(
                "publish",
                owner.userId,
                driveId,
                (yield* Clock.currentTimeMillis) + 120_000,
              );
            }
            expect(
              (yield* Effect.flip(undo(engine, first.turn.runId, "blocked", true))).message,
            ).toContain("Git operation");
            expect(yield* store.pendingRollback).toBeNull();
            expect(f.order).toEqual([]);
            if (kind === "pull") {
              yield* state.finish({
                id: operation.id,
                target: firstCommit,
                head: firstCommit,
                wip: firstCommit,
                outcome: "refused",
                reason: "cancelled",
                hasWorkingTreeChanges: false,
              });
            } else {
              yield* state.releasePublication("publish", owner.userId, driveId);
            }
            yield* undo(engine, first.turn.runId, "blocked", true);
            expect(f.order).toEqual(["stop", "restore"]);
          }),
        f.options,
      );
    },
  );

  it.effect("allows undo after a publication reservation expires", () => {
    const f = fixture();
    return withObject(
      freshDatabase(),
      (engine, runner, context) =>
        Effect.gen(function* () {
          yield* launch(engine);
          const machine = yield* connect(runner);
          const first = yield* finish(
            runner,
            machine.generation,
            1,
            f,
            firstCommit,
            null,
            "answer",
          );
          yield* Context.get(context, PullState.PullState).reservePublication(
            "expired",
            owner.userId,
            driveId,
            (yield* Clock.currentTimeMillis) - 1,
          );
          yield* undo(engine, first.turn.runId, "expired", true);
          expect(f.order).toEqual(["stop", "restore"]);
        }),
      f.options,
    );
  });

  it.effect("blocks Git admission and lease side effects until undo recovery completes", () => {
    const f = fixture();
    return withObject(
      freshDatabase(),
      (engine, runner, context) =>
        Effect.gen(function* () {
          yield* launch(engine, "launch", { ...personal, worktree });
          const machine = yield* connect(runner);
          const first = yield* finish(
            runner,
            machine.generation,
            1,
            f,
            firstCommit,
            null,
            "answer",
          );
          f.state.stopping = true;
          expect((yield* Effect.exit(undo(engine, first.turn.runId, "recover", true)))._tag).toBe(
            "Failure",
          );
          const pulls = Context.get(context, ThreadPulls.ThreadPulls);
          const state = Context.get(context, PullState.PullState);
          const store = Context.get(context, ThreadStore.ThreadStore);
          expect(
            (yield* Effect.exit(
              pulls.begin(owner, {
                driveId,
                operationId: "pull",
                branch: worktree.branch,
                target: firstCommit,
              }),
            ))._tag,
          ).toBe("Failure");
          expect(
            (yield* Effect.exit(pulls.reservePublication(owner, driveId, "publish")))._tag,
          ).toBe("Failure");
          expect(yield* state.pending).toBeNull();
          expect(yield* state.publication).toBeNull();

          // A deployment can encounter both journals left by the previous implementation.
          yield* state.insert({ actorId: owner.userId, driveId, operation });
          const sql = Context.get(context, SqlClient.SqlClient);
          yield* sql`UPDATE thread_git_pulls SET attempts = ${PullState.MAX_PULL_FAILURES}`;
          const pending = yield* state.pending;
          const lease = yield* store.machine;
          expect((yield* Effect.exit(runner.reconcile))._tag).toBe("Failure");
          expect(yield* state.pending).toEqual(pending);
          expect(yield* store.machine).toEqual(lease);
          yield* state.finish({
            id: operation.id,
            target: firstCommit,
            head: firstCommit,
            wip: firstCommit,
            outcome: "refused",
            reason: "cancelled",
            hasWorkingTreeChanges: false,
          });
          f.state.stopping = false;
          yield* engine.step;
          yield* pulls.reservePublication(owner, driveId, "publish-after-undo");
          expect((yield* state.publication)?.id).toBe("publish-after-undo");
          expect(yield* store.pendingRollback).toBeNull();
        }),
      { ...f.options, driveDirectory: f.options.rollbackDrives },
    );
  });
});
