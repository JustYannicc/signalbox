import type { PullResult } from "@signalbox/runner-protocol/PullProtocol";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { DriveDirectory } from "../drive/DriveDirectory.ts";
import { canWrite, myDriveId } from "../drive/driveAccess.ts";
import { remoteThreadWorktree } from "../user/contextProjects.ts";
import * as PullState from "./PullState.ts";
import { activeRun } from "./runLifecycle.ts";
import { type Actor, ThreadCommandRejectedError, ThreadNotFoundError } from "./ThreadAccess.ts";
import * as ThreadEngine from "./ThreadEngine.ts";
import * as ThreadStore from "./ThreadStore.ts";
import type { PullInput } from "./threadWire.ts";

type PullError = ThreadNotFoundError | ThreadCommandRejectedError;

export class ThreadPulls extends Context.Service<
  ThreadPulls,
  {
    readonly owner: (
      actor: Actor,
      driveId: string,
    ) => Effect.Effect<{ readonly userId: string; readonly driveId: string } | null, PullError>;
    readonly begin: (actor: Actor, input: PullInput) => Effect.Effect<void, PullError>;
    readonly target: (
      actor: Actor,
      driveId: string,
      id: string,
      branch: string,
    ) => Effect.Effect<string | null, PullError>;
    readonly wait: (actor: Actor, id: string) => Effect.Effect<PullResult, PullError>;
    /** Called under the engine lock, before the reporting batch is acknowledged. */
    readonly reported: (generation: number, result: PullResult) => Effect.Effect<void>;
    readonly revoke: (id: string, reason?: string) => Effect.Effect<void>;
    readonly reservePublication: (
      actor: Actor,
      driveId: string,
      id: string,
    ) => Effect.Effect<void, PullError>;
    readonly releasePublication: (actor: Actor, driveId: string, id: string) => Effect.Effect<void>;
  }
>()("@signalbox/cloud/thread/ThreadPulls") {}

const rejection = (id: string, reason: string) =>
  ThreadCommandRejectedError.forCommand({ id, type: "vcs.pull" }, reason);

const make = Effect.gen(function* () {
  const engine = yield* ThreadEngine.ThreadEngine;
  const store = yield* ThreadStore.ThreadStore;
  const state = yield* PullState.PullState;
  const directory = yield* Effect.serviceOption(DriveDirectory);
  const waiters = new Map<string, Deferred.Deferred<PullResult>>();

  const accessible = (actor: Actor, driveId: string) =>
    Effect.gen(function* () {
      if (!(yield* engine.canSee(actor))) return null;
      const owner = yield* Effect.orDie(store.owner);
      const projection = yield* engine.projection;
      if (owner === null || projection === null || directory._tag === "None") return null;
      const home = owner.driveId ?? myDriveId(owner.contextId, owner.userId);
      const expected = remoteThreadWorktree(home, projection.thread.id);
      if (
        home !== driveId ||
        projection.thread.worktreePath !== expected.path ||
        projection.thread.branch !== expected.branch
      )
        return null;
      const drive = directory.value.forDrive(home);
      if (!canWrite(yield* Effect.orDie(drive.role(actor.userId)))) return null;
      return { owner, drive, driveId: home, branch: expected.branch };
    });

  const owner: ThreadPulls["Service"]["owner"] = (actor, driveId) =>
    Effect.map(accessible(actor, driveId), (access) =>
      access === null ? null : { userId: access.owner.userId, driveId: access.driveId },
    );

  const target: ThreadPulls["Service"]["target"] = (actor, driveId, id, branch) =>
    Effect.gen(function* () {
      const access = yield* accessible(actor, driveId);
      if (access === null) return yield* new ThreadNotFoundError();
      if (access.branch !== branch)
        return yield* rejection(id, "Pull must use this thread's own remote branch.");
      const stored = yield* Effect.orDie(state.byId(id));
      return stored?.drive_id === driveId && stored.operation.branch === branch
        ? stored.operation.target
        : null;
    });

  const begin: ThreadPulls["Service"]["begin"] = (actor, input) =>
    engine
      .apply((projection) =>
        Effect.gen(function* () {
          const keep = (result: PullError | null) => ({ events: [], result });
          const access = yield* accessible(actor, input.driveId);
          if (access === null || projection === null) return keep(new ThreadNotFoundError());
          if (access.branch !== input.branch) {
            return keep(
              rejection(input.operationId, "Pull must use this thread's own remote branch."),
            );
          }
          const existing = yield* Effect.orDie(state.byId(input.operationId));
          if (existing !== null) {
            return keep(
              existing.drive_id === input.driveId &&
                existing.operation.branch === input.branch &&
                existing.operation.target === input.target
                ? null
                : rejection(input.operationId, "That pull id belongs to a different request."),
            );
          }
          // Refuse before any wait: an MCP call from this turn cannot await its own completion.
          if (
            activeRun(projection) !== undefined ||
            projection.runs.some((run) => run.status === "queued") ||
            projection.providerThreads.some((thread) => thread.status === "active")
          ) {
            return keep(
              rejection(input.operationId, "Wait for this thread's turn to finish before pulling."),
            );
          }
          if ((yield* Effect.orDie(state.pending)) !== null) {
            return keep(
              rejection(input.operationId, "Another Git operation is running on this thread."),
            );
          }
          const publication = yield* Effect.orDie(state.publication);
          if (publication !== null && publication.until_ms > (yield* Clock.currentTimeMillis)) {
            return keep(
              rejection(
                input.operationId,
                "This thread's branch is being published. Try again shortly.",
              ),
            );
          }
          if ((yield* Effect.orDie(store.machine)).drain !== undefined) {
            return keep(
              rejection(
                input.operationId,
                "This thread's machine is saving before it stops. Try again shortly.",
              ),
            );
          }
          const refs = yield* Effect.orDie(access.drive.refs(projection.thread.id));
          if (refs.remote === null) {
            return keep(rejection(input.operationId, "This thread has no remote repository."));
          }
          yield* Effect.orDie(
            state.insert({
              actorId: actor.userId,
              driveId: input.driveId,
              operation: {
                id: input.operationId,
                target: input.target,
                expectedThread: refs.thread,
                expectedWip: refs.wip,
                revision: refs.revision ?? null,
                branch: input.branch,
              },
            }),
          );
          return keep(null);
        }),
      )
      .pipe(Effect.flatMap((error) => (error === null ? Effect.void : Effect.fail(error))));

  const wait: ThreadPulls["Service"]["wait"] = (actor, id) =>
    Effect.gen(function* () {
      // Register before reading storage, so a report cannot land in between and be missed.
      let done = waiters.get(id);
      if (done === undefined) {
        done = yield* Deferred.make<PullResult>();
        waiters.set(id, done);
      }
      if (!(yield* engine.canSee(actor))) return yield* new ThreadNotFoundError();
      const stored = yield* Effect.orDie(state.byId(id));
      if (stored === null || (yield* accessible(actor, stored.drive_id)) === null) {
        return yield* new ThreadNotFoundError();
      }
      if (stored.result !== null) {
        waiters.delete(id);
        return stored.result;
      }
      return yield* Deferred.await(done);
    });

  const reported: ThreadPulls["Service"]["reported"] = (generation, result) =>
    Effect.gen(function* () {
      const stored = yield* Effect.orDie(state.byId(result.id));
      if (
        stored === null ||
        stored.phase === "completed" ||
        stored.generation !== generation ||
        stored.operation.target !== result.target
      )
        return;
      // The drive receipt commits with its refs. A successful report is accepted only from it.
      const owner = yield* Effect.orDie(store.owner);
      const projection = yield* engine.projection;
      if (owner === null || projection === null || directory._tag === "None") return;
      const receipt = yield* Effect.orDie(
        directory.value.forDrive(stored.drive_id).pullReceipt(
          {
            threadId: projection.thread.id,
            userId: owner.userId,
            generation,
            live: false,
            packsAfter: 0,
          },
          result.id,
        ),
      );
      // Refusal before a drive write (dirty overlap, missing credentials) may have no receipt.
      if (receipt === null && result.outcome !== "refused") return;
      const settled = receipt ?? result;
      yield* Effect.orDie(state.finish(settled));
      const waiter = waiters.get(result.id);
      if (waiter !== undefined) {
        yield* Deferred.succeed(waiter, settled);
        waiters.delete(result.id);
      }
    });

  const revoke: ThreadPulls["Service"]["revoke"] = (
    id,
    reason = "You no longer have access to change this drive.",
  ) =>
    Effect.gen(function* () {
      const pending = yield* Effect.orDie(state.byId(id));
      if (pending === null || pending.phase === "completed") return;
      const result: PullResult = {
        id,
        target: pending.operation.target,
        head: pending.operation.expectedThread,
        wip: pending.operation.expectedWip,
        outcome: "refused",
        reason,
        hasWorkingTreeChanges:
          pending.operation.expectedWip !== null &&
          pending.operation.expectedWip !== pending.operation.expectedThread,
      };
      yield* Effect.orDie(state.finish(result));
      const waiter = waiters.get(id);
      if (waiter !== undefined) {
        yield* Deferred.succeed(waiter, result);
        waiters.delete(id);
      }
    });

  const reservePublication: ThreadPulls["Service"]["reservePublication"] = (actor, driveId, id) =>
    engine
      .apply(() =>
        Effect.gen(function* () {
          const keep = (result: PullError | null) => ({ events: [], result });
          if ((yield* accessible(actor, driveId)) === null) return keep(new ThreadNotFoundError());
          const publication = yield* Effect.orDie(state.publication);
          const now = yield* Clock.currentTimeMillis;
          if (
            (yield* Effect.orDie(state.pending)) !== null ||
            (publication !== null && publication.until_ms > now)
          ) {
            return keep(rejection(id, "Another Git operation is running on this thread."));
          }
          // Publication has a shorter request timeout. A terminated caller cannot strand this slot.
          yield* Effect.orDie(state.reservePublication(id, actor.userId, driveId, now + 120_000));
          return keep(null);
        }),
      )
      .pipe(Effect.flatMap((error) => (error === null ? Effect.void : Effect.fail(error))));

  const releasePublication: ThreadPulls["Service"]["releasePublication"] = (actor, driveId, id) =>
    engine.apply(() =>
      Effect.as(Effect.orDie(state.releasePublication(id, actor.userId, driveId)), {
        events: [],
        result: undefined,
      }),
    );

  return ThreadPulls.of({
    owner,
    target,
    begin,
    wait,
    reported,
    revoke,
    reservePublication,
    releasePublication,
  });
});

export const layer = Layer.effect(ThreadPulls, make);

export const layerReports = Layer.effect(
  PullState.PullReports,
  Effect.map(ThreadPulls, ({ reported, revoke }) => ({ reported, revoke })),
);
