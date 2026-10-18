import type { PullResult } from "@signalbox/runner-protocol/PullProtocol";
import type { RunnerHello } from "@signalbox/runner-protocol/RunnerProtocol";
import { CommandId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { DriveDirectory, handleFor } from "../drive/DriveDirectory.ts";
import { wipRef } from "../drive/DriveStore.ts";
import { uploadPack } from "../drive/DriveUploads.ts";
import { makeMemoryDrives, makeRepo } from "../drive/driveTesting.ts";
import { remoteThreadWorktree } from "../user/contextProjects.ts";
import * as ThreadPulls from "./ThreadPulls.ts";
import * as PullState from "./PullState.ts";
import {
  IDLE_TAIL_MS,
  onRunnerMessage,
  pushRunnerWork,
  connect,
  fakeSocket,
  freshDatabase,
  hello,
  hostFor,
  launch,
  liveTurn,
  owner,
  personal,
  send,
  threadId,
  turnReport,
  withObject,
} from "./runnerTesting.ts";

const DRIVE = "my/personal/user_1";
const remote = { provider: "github", repository: "owner/repo", defaultBranch: "main" } as const;
const worktree = remoteThreadWorktree(DRIVE, threadId);

const withFixture = <A, E>(
  use: (fixture: {
    readonly database: string;
    readonly directory: Layer.Layer<DriveDirectory>;
    readonly handle: ReturnType<ReturnType<typeof makeMemoryDrives>["apiFor"]>;
    readonly first: string;
    readonly target: string;
  }) => Effect.Effect<A, E>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const repo = yield* Effect.acquireRelease(Effect.sync(makeRepo), (repo) =>
        Effect.sync(repo.cleanup),
      );
      repo.write("first.txt", "base\n");
      const first = repo.commit("first");
      repo.write("remote.txt", "external advance\n");
      const target = repo.commit("remote");
      const memory = makeMemoryDrives();
      const handle = memory.apiFor(DRIVE);
      const writer = { threadId, userId: owner.userId, generation: 1, live: true, packsAfter: 0 };
      yield* Effect.promise(() => handle.setRemote(remote));
      yield* uploadPack({ driveId: DRIVE, threadId, ...repo.pack([target]) }).pipe(
        Effect.provide(memory.layer),
      );
      yield* Effect.promise(() => handle.mirror(writer, { expectedMain: null, newMain: first }));
      yield* Effect.promise(() => handle.open(writer));
      return yield* use({
        database: freshDatabase(),
        directory: Layer.succeed(DriveDirectory, {
          forDrive: (id) => handleFor(memory.apiFor(id)),
        }),
        handle,
        first,
        target,
      });
    }),
  );

const idle = (
  engine: Parameters<Parameters<typeof withObject>[1]>[0],
  runner: Parameters<Parameters<typeof withObject>[1]>[1],
) =>
  Effect.gen(function* () {
    yield* launch(engine, "launch", { ...personal, worktree });
    const machine = yield* connect(runner);
    const turn = yield* liveTurn(runner);
    const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
    yield* runner.batch({
      generation: machine.generation,
      sequence: 1,
      items: [report.started, report.terminal],
    });
    return machine;
  });

describe("durable thread pull", () => {
  it.effect("permits an in-flight pull save before reconnect replay is dispatched", () =>
    withFixture((f) =>
      withObject(
        f.database,
        (engine, runner, context) =>
          Effect.gen(function* () {
            const machine = yield* idle(engine, runner);
            const pulls = Context.get(context, ThreadPulls.ThreadPulls);
            const state = Context.get(context, PullState.PullState);
            yield* pulls.begin(owner, {
              driveId: DRIVE,
              operationId: "reconnecting-pull",
              target: f.target,
              branch: worktree.branch,
            });
            const work = yield* runner.work;
            yield* runner.disconnected({
              generation: machine.generation,
              connection: 1,
              detail: "1006",
            });
            expect((yield* runner.hello(hello(machine.generation, machine.token)))._tag).toBe(
              "welcome",
            );
            expect(yield* state.pending).toMatchObject({ phase: "selected", attempts: 1 });
            expect(yield* runner.authorizeDrive(work.pull!.drive.token)).toMatchObject({
              _tag: "granted",
              pullOperationId: "reconnecting-pull",
            });
          }),
        { drives: true, driveDirectory: f.directory },
      ),
    ),
  );

  it.effect.each(["thread.archive", "thread.settle"] as const)(
    "%s finishes a pending pull, then saves before release despite an open preview",
    (type) =>
      withFixture((f) =>
        withObject(
          f.database,
          (engine, runner, context) =>
            Effect.gen(function* () {
              const machine = yield* idle(engine, runner);
              const pulls = Context.get(context, ThreadPulls.ThreadPulls);
              yield* pulls.begin(owner, {
                driveId: DRIVE,
                operationId: "closing-pull",
                target: f.target,
                branch: worktree.branch,
              });
              yield* engine.dispatch(
                owner,
                { type, commandId: CommandId.make("close-pulling"), threadId },
                { ...personal, worktree },
              );
              expect(yield* runner.reconcile).toMatchObject({ busy: true, release: null });
              expect((yield* runner.work).pull?.operation.id).toBe("closing-pull");
              yield* runner.batch({
                generation: machine.generation,
                sequence: 2,
                items: [
                  {
                    kind: "git.pull.result",
                    result: {
                      id: "closing-pull",
                      target: f.target,
                      head: f.first,
                      wip: null,
                      outcome: "refused",
                      reason: "No change was made.",
                      hasWorkingTreeChanges: false,
                    },
                  },
                ],
              });
              const plan = yield* runner.reconcile;
              expect(plan.release).toBeNull();
              expect(plan.drain).toMatchObject({ generation: machine.generation });
              yield* runner.batch({
                generation: machine.generation,
                sequence: 3,
                items: [{ kind: "machine.drained", id: plan.drain!.id, unsaved: [] }],
              });
              expect((yield* runner.reconcile).release).toBe(machine.generation);
              expect((yield* runner.reconcile).ensure).toBeNull();
            }),
          {
            drives: true,
            driveDirectory: f.directory,
            previews: { held: true, lastActiveAt: null },
          },
        ),
      ),
  );

  it.effect.each(["thread.archive", "thread.settle"] as const)(
    "%s drains before an exhausted pull fences its machine",
    (type) =>
      withFixture((f) =>
        withObject(
          f.database,
          (engine, runner, context) =>
            Effect.gen(function* () {
              const machine = yield* idle(engine, runner);
              const pulls = Context.get(context, ThreadPulls.ThreadPulls);
              const state = Context.get(context, PullState.PullState);
              yield* pulls.begin(owner, {
                driveId: DRIVE,
                operationId: "closing-exhausted",
                target: f.target,
                branch: worktree.branch,
              });
              yield* engine.dispatch(
                owner,
                { type, commandId: CommandId.make("close-exhausting"), threadId },
                { ...personal, worktree },
              );
              for (let attempt = 0; attempt < 3; attempt++) {
                expect((yield* runner.work).pull?.operation.id).toBe("closing-exhausted");
                yield* runner.batch({
                  generation: machine.generation,
                  sequence: 2 + attempt,
                  items: [{ kind: "git.pull.interrupted", id: "closing-exhausted" }],
                });
                yield* TestClock.adjust(1_000 * 2 ** attempt);
              }
              const plan = yield* runner.reconcile;
              expect(plan.release).toBeNull();
              expect(plan.drain).toMatchObject({ generation: machine.generation });
              expect(yield* state.pending).not.toBeNull();
              yield* runner.batch({
                generation: machine.generation,
                sequence: 5,
                items: [{ kind: "machine.drained", id: plan.drain!.id, unsaved: [] }],
              });
              yield* runner.disconnected({
                generation: machine.generation,
                connection: 1,
                detail: "1006",
              });
              expect((yield* runner.reconcile).release).toBe(machine.generation);
              expect(yield* state.pending).toBeNull();
              expect((yield* pulls.wait(owner, "closing-exhausted")).outcome).toBe("refused");
            }),
          { drives: true, driveDirectory: f.directory },
        ),
      ),
  );

  it.effect.each(["thread.archive", "thread.settle"] as const)(
    "%s keeps unsaved files after pull access is revoked",
    (type) =>
      withFixture((f) => {
        let permitted = true;
        return withObject(
          f.database,
          (engine, runner, context) =>
            Effect.gen(function* () {
              const machine = yield* idle(engine, runner);
              const pulls = Context.get(context, ThreadPulls.ThreadPulls);
              yield* pulls.begin(owner, {
                driveId: DRIVE,
                operationId: "closing-revoked",
                target: f.target,
                branch: worktree.branch,
              });
              const work = yield* runner.work;
              expect(yield* runner.authorizeDrive(work.pull!.drive.token)).toMatchObject({
                _tag: "granted",
                pullOperationId: "closing-revoked",
              });
              yield* engine.dispatch(
                owner,
                { type, commandId: CommandId.make("close-revoked"), threadId },
                { ...personal, worktree },
              );
              permitted = false;
              const plan = yield* runner.reconcile;
              expect(plan.release).toBeNull();
              expect(plan.drain).toMatchObject({ generation: machine.generation });
              yield* runner.batch({
                generation: machine.generation,
                sequence: 2,
                items: [
                  { kind: "machine.drained", id: plan.drain!.id, unsaved: ["access denied"] },
                ],
              });
              const waiting = yield* runner.reconcile;
              expect(waiting.release).toBeNull();
              permitted = true;
              expect(yield* runner.authorizeDrive(work.pull!.drive.token)).toMatchObject({
                _tag: "granted",
                pullOperationId: null,
              });
              yield* TestClock.adjust(waiting.wakeAt! - (yield* Clock.currentTimeMillis));
              const retry = yield* runner.reconcile;
              yield* runner.batch({
                generation: machine.generation,
                sequence: 3,
                items: [{ kind: "machine.drained", id: retry.drain!.id, unsaved: [] }],
              });
              expect((yield* runner.reconcile).release).toBe(machine.generation);
              expect((yield* pulls.wait(owner, "closing-revoked")).outcome).toBe("refused");
            }),
          { drives: true, driveDirectory: f.directory, writes: () => Effect.succeed(permitted) },
        );
      }),
  );

  it.effect.each(["interrupted", "lost"] as const)(
    "ends after three %s attempts, wakes its caller and fences late saves before the next turn",
    (failure) =>
      withFixture((f) =>
        withObject(
          f.database,
          (engine, runner, context) =>
            Effect.gen(function* () {
              let machine = yield* idle(engine, runner);
              const pulls = Context.get(context, ThreadPulls.ThreadPulls);
              const state = Context.get(context, PullState.PullState);
              yield* Effect.promise(() =>
                f.handle.updateRefs(
                  {
                    threadId,
                    userId: owner.userId,
                    generation: machine.generation,
                    live: false,
                    packsAfter: 0,
                  },
                  [{ name: wipRef(threadId), old: null, new: f.target }],
                ),
              );
              yield* pulls.begin(owner, {
                driveId: DRIVE,
                operationId: "bounded",
                target: f.target,
                branch: worktree.branch,
              });
              const waiting = yield* Effect.forkChild(pulls.wait(owner, "bounded"));
              const firstWork = yield* runner.work;
              const operation = firstWork.pull!.operation;
              const workToken = firstWork.pull!.drive.token;
              for (let attempt = 0; attempt < 3; attempt++) {
                const work = yield* runner.work;
                expect(work.pull?.operation).toEqual(operation);
                expect((yield* runner.reconcile).busy).toBe(true);
                if (failure === "interrupted") {
                  const batch = {
                    generation: machine.generation,
                    sequence: 2 + attempt * 2,
                    items: [
                      { kind: "git.pull.interrupted", id: "bounded" },
                      { kind: "git.pull.interrupted", id: "bounded" },
                    ] as const,
                  };
                  yield* runner.batch(batch);
                  yield* runner.batch(batch);
                  yield* runner.batch({ ...batch, sequence: batch.sequence + 1 });
                  expect((yield* state.byId("bounded"))?.attempts).toBe(attempt + 1);
                  expect((yield* runner.work).pull).toBeNull();
                } else {
                  yield* runner.machineExited(machine.generation, {
                    detail: "out of memory",
                    outOfMemory: true,
                  });
                  yield* runner.ended(machine.generation, "duplicate loss notification");
                }
                if (attempt < 2) {
                  if (failure === "interrupted") {
                    yield* TestClock.adjust(1_000 * 2 ** attempt);
                  } else {
                    machine = yield* connect(runner);
                    expect((yield* state.byId("bounded"))?.attempts).toBe(attempt + 1);
                  }
                }
              }
              const stopped = yield* runner.reconcile;
              expect(stopped.ensure).toBeNull();
              expect(stopped.busy).toBe(false);
              expect(yield* state.pending).toBeNull();
              expect(yield* Fiber.join(waiting)).toMatchObject({
                id: "bounded",
                outcome: "refused",
                head: f.first,
                wip: f.target,
                hasWorkingTreeChanges: true,
                reason: "Pull stopped after three failed attempts. Try pulling again.",
              });
              expect((yield* runner.authorizeDrive(workToken))._tag).toBe("denied");
              yield* send(engine, 2, "continue after failed pull");
              const late = yield* Effect.promise(() =>
                f.handle.savePull(
                  {
                    threadId,
                    userId: owner.userId,
                    generation: machine.generation,
                    live: false,
                    packsAfter: 0,
                  },
                  {
                    operation,
                    result: {
                      id: operation.id,
                      target: f.target,
                      head: f.target,
                      wip: f.target,
                      outcome: "pulled",
                      reason: null,
                      hasWorkingTreeChanges: false,
                    },
                  },
                ),
              );
              expect(late.outcome).toBe("refused");
              expect(yield* Effect.promise(() => f.handle.refs(threadId))).toMatchObject({
                thread: f.first,
                wip: f.target,
              });
              expect((yield* runner.reconcile).ensure).not.toBeNull();
            }),
          { drives: true, driveDirectory: f.directory },
        ),
      ),
  );

  it.effect.each(["interrupted", "lost"] as const)(
    "keeps a committed success whose report was lost at the %s attempt limit",
    (failure) =>
      withFixture((f) =>
        withObject(
          f.database,
          (engine, runner, context) =>
            Effect.gen(function* () {
              let machine = yield* idle(engine, runner);
              const pulls = Context.get(context, ThreadPulls.ThreadPulls);
              yield* pulls.begin(owner, {
                driveId: DRIVE,
                operationId: "saved-at-limit",
                target: f.target,
                branch: worktree.branch,
              });
              const waiting = yield* Effect.forkChild(pulls.wait(owner, "saved-at-limit"));
              const operation = (yield* runner.work).pull!.operation;
              const result: PullResult = {
                id: operation.id,
                target: f.target,
                head: f.target,
                wip: f.target,
                outcome: "pulled",
                reason: null,
                hasWorkingTreeChanges: false,
              };
              for (let attempt = 0; attempt < 3; attempt++) {
                yield* runner.work;
                if (attempt === 2) {
                  const writer = {
                    threadId,
                    userId: owner.userId,
                    generation: machine.generation,
                    live: false,
                    packsAfter: 0,
                  };
                  yield* Effect.promise(() => f.handle.open(writer));
                  expect(
                    yield* Effect.promise(() => f.handle.savePull(writer, { operation, result })),
                  ).toEqual(result);
                }
                if (failure === "interrupted") {
                  yield* runner.batch({
                    generation: machine.generation,
                    sequence: attempt + 2,
                    items: [{ kind: "git.pull.interrupted", id: operation.id }],
                  });
                  if (attempt < 2) yield* TestClock.adjust(1_000 * 2 ** attempt);
                } else {
                  yield* runner.ended(machine.generation, "lost completion");
                  if (attempt < 2) machine = yield* connect(runner);
                }
              }
              expect((yield* runner.reconcile).ensure).toBeNull();
              expect(yield* Context.get(context, PullState.PullState).pending).toBeNull();
              expect(yield* Fiber.join(waiting)).toEqual(result);
              expect((yield* Effect.promise(() => f.handle.refs(threadId))).thread).toBe(f.target);
              yield* send(engine, 2, "continue after successful pull");
            }),
          { drives: true, driveDirectory: f.directory },
        ),
      ),
  );

  it.effect("bounds machines that never connect across object eviction", () =>
    withFixture((f) =>
      Effect.gen(function* () {
        yield* withObject(
          f.database,
          (engine, runner, context) =>
            Effect.gen(function* () {
              const machine = yield* idle(engine, runner);
              yield* runner.ended(machine.generation, "finished before pull");
              yield* Context.get(context, ThreadPulls.ThreadPulls).begin(owner, {
                driveId: DRIVE,
                operationId: "no-runner",
                target: f.target,
                branch: worktree.branch,
              });
            }),
          { drives: true, driveDirectory: f.directory },
        );
        for (let attempt = 0; attempt < 3; attempt++) {
          yield* withObject(
            f.database,
            (_engine, runner) =>
              Effect.gen(function* () {
                const requested = yield* runner.reconcile;
                expect(requested.ensure?.generation).toBe(attempt + 2);
                yield* TestClock.adjust("1 hour");
                expect((yield* runner.reconcile).release).toBe(attempt + 2);
              }),
            { drives: true, driveDirectory: f.directory },
          );
        }
        yield* withObject(
          f.database,
          (engine, runner, context) =>
            Effect.gen(function* () {
              const stopped = yield* runner.reconcile;
              expect(stopped.ensure).toBeNull();
              expect(stopped.busy).toBe(false);
              expect(
                (yield* Context.get(context, PullState.PullState).byId("no-runner"))?.attempts,
              ).toBe(3);
              expect(
                (yield* Context.get(context, ThreadPulls.ThreadPulls).wait(owner, "no-runner"))
                  .outcome,
              ).toBe("refused");
              expect((yield* runner.reconcile).ensure).toBeNull();
              yield* send(engine, 2, "retry with a normal turn");
              expect((yield* runner.reconcile).ensure).not.toBeNull();
            }),
          { drives: true, driveDirectory: f.directory },
        );
      }),
    ),
  );

  it.effect.each([5, 6])(
    "refuses Pull on a protocol %i runner without the capability",
    (protocolVersion) =>
      withFixture((f) =>
        withObject(
          f.database,
          (engine, runner, context) =>
            Effect.gen(function* () {
              const machine = yield* idle(engine, runner);
              const legacyHello: RunnerHello = {
                ...hello(machine.generation, machine.token),
                protocolVersion,
              };
              Reflect.deleteProperty(legacyHello, "pulls");
              expect((yield* runner.hello(legacyHello))._tag).toBe("welcome");
              const pulls = Context.get(context, ThreadPulls.ThreadPulls);
              yield* pulls.begin(owner, {
                driveId: DRIVE,
                operationId: "old-runner",
                target: f.target,
                branch: worktree.branch,
              });
              expect((yield* runner.work).pull).toBeNull();
              expect(yield* pulls.wait(owner, "old-runner")).toMatchObject({
                outcome: "refused",
                reason: "This thread's machine needs an update before it can pull.",
              });
              expect(yield* Context.get(context, PullState.PullState).pending).toBeNull();
              yield* send(engine, 2, "continue normally");
              expect((yield* runner.work).turn).not.toBeNull();
            }),
          { drives: true, driveDirectory: f.directory },
        ),
      ),
  );

  it.effect(
    "serializes pull admission with publication and recovers a reservation whose caller went away",
    () =>
      withFixture((f) =>
        withObject(
          f.database,
          (engine, runner, context) =>
            Effect.gen(function* () {
              yield* idle(engine, runner);
              const pulls = Context.get(context, ThreadPulls.ThreadPulls);
              const input = {
                driveId: DRIVE,
                operationId: "pull",
                target: f.target,
                branch: worktree.branch,
              };
              yield* pulls.reservePublication(owner, DRIVE, "publish");
              expect((yield* pulls.begin(owner, input).pipe(Effect.result))._tag).toBe("Failure");
              expect(
                (yield* pulls.reservePublication(owner, DRIVE, "other").pipe(Effect.result))._tag,
              ).toBe("Failure");
              yield* pulls.releasePublication(owner, DRIVE, "other");
              expect((yield* pulls.begin(owner, input).pipe(Effect.result))._tag).toBe("Failure");
              yield* TestClock.adjust(120_001);
              yield* pulls.begin(owner, input);
              expect(
                (yield* pulls.reservePublication(owner, DRIVE, "other").pipe(Effect.result))._tag,
              ).toBe("Failure");
            }),
          { drives: true, driveDirectory: f.directory },
        ),
      ),
  );

  it.effect(
    "retries an interrupted upload on the same connection and target after its durable backoff",
    () =>
      withFixture((f) =>
        withObject(
          f.database,
          (engine, runner, context) =>
            Effect.gen(function* () {
              const machine = yield* idle(engine, runner);
              const pulls = Context.get(context, ThreadPulls.ThreadPulls);
              yield* pulls.begin(owner, {
                driveId: DRIVE,
                operationId: "retry",
                target: f.target,
                branch: worktree.branch,
              });
              const socket = fakeSocket();
              const host = yield* hostFor(runner, [socket.socket]);
              yield* Effect.promise(() =>
                onRunnerMessage(
                  host,
                  socket.socket,
                  JSON.stringify(hello(machine.generation, machine.token)),
                ),
              );
              expect(socket.sent.filter((message) => message.type === "git.pull")).toHaveLength(1);
              yield* runner.batch({
                generation: machine.generation,
                sequence: 2,
                items: [
                  { kind: "git.pull.interrupted", id: "retry" },
                  { kind: "git.pull.interrupted", id: "retry" },
                ],
              });
              const waiting = yield* runner.work;
              expect(waiting.pull).toBeNull();
              expect((yield* runner.reconcile).wakeAt).toBe(
                (yield* Clock.currentTimeMillis) + 1_000,
              );
              yield* TestClock.adjust(1_000);
              yield* Effect.promise(() => pushRunnerWork(host));
              const sent = socket.sent.filter((message) => message.type === "git.pull");
              expect(sent).toHaveLength(2);
              expect(sent[1]).toEqual(sent[0]);
              expect(yield* pulls.target(owner, DRIVE, "retry", worktree.branch)).toBe(f.target);
              expect((yield* Context.get(context, PullState.PullState).pending)?.phase).toBe(
                "running",
              );
            }),
          { drives: true, driveDirectory: f.directory },
        ),
      ),
  );

  it.effect(
    "starts an idle machine and replays its selected target across eviction and machine generations",
    () =>
      withFixture((f) =>
        Effect.gen(function* () {
          const input = {
            driveId: DRIVE,
            operationId: "pull-1",
            target: f.target,
            branch: worktree.branch,
          };
          yield* withObject(
            f.database,
            (engine, runner, context) =>
              Effect.gen(function* () {
                const machine = yield* idle(engine, runner);
                yield* runner.ended(machine.generation, "gone");
                const pulls = Context.get(context, ThreadPulls.ThreadPulls);
                yield* pulls.begin(owner, input);
                expect((yield* runner.work).needsUpkeep).toBe(true);
                const next = yield* connect(runner);
                const work = yield* runner.work;
                expect(work.pull?.operation).toEqual({
                  id: input.operationId,
                  target: f.target,
                  expectedThread: f.first,
                  expectedWip: null,
                  revision: null,
                  branch: worktree.branch,
                });
                expect(work.turn).toBeNull();
                expect((yield* runner.reconcile).busy).toBe(true);
                expect((yield* runner.authorizeRemote(work.pull!.drive.remoteToken!))._tag).toBe(
                  "granted",
                );
                yield* runner.ended(next.generation, "interrupted before apply");
              }),
            { drives: true, driveDirectory: f.directory },
          );

          yield* withObject(
            f.database,
            (_engine, runner, context) =>
              Effect.gen(function* () {
                const pulls = Context.get(context, ThreadPulls.ThreadPulls);
                // A newer remote answer on retry cannot change the durable target.
                expect(
                  (yield* pulls.begin(owner, { ...input, target: f.first }).pipe(Effect.result))
                    ._tag,
                ).toBe("Failure");
                expect(yield* pulls.target(owner, DRIVE, input.operationId, worktree.branch)).toBe(
                  f.target,
                );
                yield* pulls.begin(owner, input);
                const machine = yield* connect(runner);
                const work = yield* runner.work;
                expect(work.pull?.operation.target).toBe(f.target);
                expect(machine.generation).toBe(3);
                expect((yield* runner.batch({ generation: 2, sequence: 2, items: [] }))._tag).toBe(
                  "stale",
                );
              }),
            { drives: true, driveDirectory: f.directory },
          );
        }),
      ),
  );

  it.effect(
    "settles from the atomic drive receipt after refs saved but completion lost, and deduplicates batches",
    () =>
      withFixture((f) =>
        withObject(
          f.database,
          (engine, runner, context) =>
            Effect.gen(function* () {
              const original = yield* idle(engine, runner);
              const pulls = Context.get(context, ThreadPulls.ThreadPulls);
              yield* pulls.begin(owner, {
                driveId: DRIVE,
                operationId: "pull",
                target: f.target,
                branch: worktree.branch,
              });
              const operation = (yield* runner.work).pull!.operation;
              const result: PullResult = {
                id: "pull",
                target: f.target,
                head: f.target,
                wip: f.target,
                outcome: "pulled",
                reason: null,
                hasWorkingTreeChanges: false,
              };
              yield* Effect.promise(() =>
                f.handle.savePull(
                  {
                    threadId,
                    userId: owner.userId,
                    generation: original.generation,
                    live: false,
                    packsAfter: 0,
                  },
                  { operation, result },
                ),
              );
              yield* runner.ended(original.generation, "lost completion");
              const fresh = yield* connect(runner);
              yield* runner.work;
              const waiting = yield* Effect.forkChild(pulls.wait(owner, "pull"));
              const report = { kind: "git.pull.result", result } as const;
              const batch = { generation: fresh.generation, sequence: 1, items: [report, report] };
              expect(yield* runner.batch(batch)).toEqual({ _tag: "ack", sequence: 1 });
              expect(yield* Fiber.join(waiting)).toEqual(result);
              expect(yield* runner.batch(batch)).toEqual({ _tag: "ack", sequence: 1 });
              expect((yield* runner.work).pull).toBeNull();
              expect(yield* pulls.wait(owner, "pull")).toEqual(result);
              expect(
                (yield* runner.authorizeRemote((yield* runner.previewDrive)!.token))._tag,
              ).toBe("denied");
            }),
          { drives: true, driveDirectory: f.directory },
        ),
      ),
  );

  it.effect(
    "sends one command per connection and counts replay after reconnect without changing target",
    () =>
      withFixture((f) =>
        withObject(
          f.database,
          (engine, runner, context) =>
            Effect.gen(function* () {
              const machine = yield* idle(engine, runner);
              yield* Context.get(context, ThreadPulls.ThreadPulls).begin(owner, {
                driveId: DRIVE,
                operationId: "pull",
                target: f.target,
                branch: worktree.branch,
              });
              const socket = fakeSocket();
              const sockets = [socket.socket];
              const host = yield* hostFor(runner, sockets);
              yield* Effect.promise(() =>
                onRunnerMessage(
                  host,
                  socket.socket,
                  JSON.stringify(hello(machine.generation, machine.token)),
                ),
              );
              yield* Effect.promise(() => pushRunnerWork(host));
              yield* Effect.promise(() => pushRunnerWork(host));
              expect(socket.sent.filter((message) => message.type === "git.pull")).toHaveLength(1);
              const next = fakeSocket();
              sockets.push(next.socket);
              yield* Effect.promise(() =>
                onRunnerMessage(
                  host,
                  next.socket,
                  JSON.stringify(hello(machine.generation, machine.token)),
                ),
              );
              expect(next.sent.find((message) => message.type === "git.pull")).toEqual(
                socket.sent.find((message) => message.type === "git.pull"),
              );
              expect((yield* Context.get(context, PullState.PullState).pending)?.attempts).toBe(1);
            }),
          { drives: true, driveDirectory: f.directory },
        ),
      ),
  );

  it.effect.each([false, true])(
    "bounds same-generation restarts and arms terminal upkeep when a receipt exists: %s",
    (saved) =>
      withFixture((f) =>
        withObject(
          f.database,
          (engine, runner, context) =>
            Effect.gen(function* () {
              const machine = yield* idle(engine, runner);
              const pulls = Context.get(context, ThreadPulls.ThreadPulls);
              const state = Context.get(context, PullState.PullState);
              yield* pulls.begin(owner, {
                driveId: DRIVE,
                operationId: "restart",
                target: f.target,
                branch: worktree.branch,
              });
              const waiting = yield* Effect.forkChild(pulls.wait(owner, "restart"));
              const socket = fakeSocket();
              const sockets = [socket.socket];
              const connections = [socket];
              const upkeep: boolean[] = [];
              const host = yield* hostFor(runner, sockets);
              const observed = {
                ...host,
                afterChange: async (work?: Awaited<ReturnType<typeof pushRunnerWork>>) => {
                  upkeep.push(work?.needsUpkeep ?? false);
                },
              };
              const reconnect = (next: ReturnType<typeof fakeSocket>) =>
                Effect.promise(() =>
                  onRunnerMessage(
                    observed,
                    next.socket,
                    JSON.stringify(hello(machine.generation, machine.token)),
                  ),
                );
              yield* reconnect(socket);
              const firstWork = yield* runner.work;
              const operation = firstWork.pull!.operation;
              const writer = {
                threadId,
                userId: owner.userId,
                generation: machine.generation,
                live: false,
                packsAfter: 0,
              };
              const result: PullResult = {
                id: operation.id,
                target: f.target,
                head: f.target,
                wip: f.target,
                outcome: "pulled",
                reason: null,
                hasWorkingTreeChanges: false,
              };
              expect((yield* state.pending)?.attempts).toBe(0);
              for (let attempt = 1; attempt <= 3; attempt++) {
                if (saved && attempt === 3) {
                  expect(
                    yield* Effect.promise(() => f.handle.savePull(writer, { operation, result })),
                  ).toEqual(result);
                }
                const next = fakeSocket();
                connections.push(next);
                sockets.splice(0, sockets.length, next.socket);
                yield* reconnect(next);
                expect((yield* state.pending)?.attempts).toBe(attempt);
                expect((yield* state.pending)?.operation).toEqual(operation);
              }
              expect(upkeep.at(-1)).toBe(true);
              expect((yield* runner.work).pull).toBeNull();
              expect((yield* runner.work).needsUpkeep).toBe(true);
              const duplicate = fakeSocket();
              connections.push(duplicate);
              sockets.splice(0, sockets.length, duplicate.socket);
              yield* reconnect(duplicate);
              expect((yield* state.pending)?.attempts).toBe(3);
              expect(
                connections
                  .flatMap((connection) => connection.sent)
                  .filter((message) => message.type === "git.pull"),
              ).toHaveLength(3);
              const stopped = yield* runner.reconcile;
              expect(stopped.release).toBe(machine.generation);
              expect(stopped.ensure).toBeNull();
              expect(stopped.busy).toBe(false);
              expect(yield* state.pending).toBeNull();
              expect(yield* Fiber.join(waiting)).toMatchObject(
                saved
                  ? result
                  : {
                      outcome: "refused",
                      reason: "Pull stopped after three failed attempts. Try pulling again.",
                    },
              );
              expect((yield* runner.authorizeDrive(firstWork.pull!.drive.token))._tag).toBe(
                "denied",
              );
              yield* send(engine, 2, "continue after restarts");
              expect(
                (yield* Effect.promise(() => f.handle.savePull(writer, { operation, result })))
                  .outcome,
              ).toBe("refused");
              expect((yield* Effect.promise(() => f.handle.refs(threadId))).thread).toBe(
                saved ? f.target : f.first,
              );
              expect((yield* runner.reconcile).ensure).not.toBeNull();
            }),
          { drives: true, driveDirectory: f.directory },
        ),
      ),
  );

  it.effect(
    "refuses its own live turn, foreign actors, forged drives and concurrent operations",
    () =>
      withFixture((f) =>
        withObject(
          f.database,
          (engine, runner, context) =>
            Effect.gen(function* () {
              yield* launch(engine, "launch", { ...personal, worktree });
              const pulls = Context.get(context, ThreadPulls.ThreadPulls);
              const input = {
                driveId: DRIVE,
                operationId: "pull",
                target: f.target,
                branch: worktree.branch,
              };
              const busy = yield* pulls.begin(owner, input).pipe(Effect.result);
              expect(busy._tag === "Failure" && busy.failure.message).toContain("turn to finish");
              const machine = yield* connect(runner);
              const turn = yield* liveTurn(runner);
              const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
              yield* runner.batch({
                generation: machine.generation,
                sequence: 1,
                items: [report.started, report.terminal],
              });
              expect(
                (yield* pulls.begin({ ...owner, userId: "other" }, input).pipe(Effect.result))._tag,
              ).toBe("Failure");
              expect(
                (yield* pulls
                  .begin(owner, { ...input, driveId: "my/personal/other" })
                  .pipe(Effect.result))._tag,
              ).toBe("Failure");
              yield* pulls.begin(owner, input);
              expect(
                (yield* pulls.begin(owner, { ...input, operationId: "other" }).pipe(Effect.result))
                  ._tag,
              ).toBe("Failure");
              const refused = yield* send(engine, 2, "wait").pipe(Effect.flip);
              expect(refused).toMatchObject({
                code: "unavailable",
                message: expect.stringContaining("pull to finish"),
              });
              yield* pulls.revoke("pull");
              yield* send(engine, 2, "wait");
              yield* send(engine, 2, "wait");
              expect((yield* engine.snapshot(owner)).projection.runs).toHaveLength(2);
            }),
          { drives: true, driveDirectory: f.directory },
        ),
      ),
  );

  it.effect(
    "holds TTL demand through the idle tail and revokes operation tokens with the requesting person's write access",
    () =>
      withFixture((f) => {
        let permitted = true;
        return withObject(
          f.database,
          (engine, runner, context) =>
            Effect.gen(function* () {
              yield* idle(engine, runner);
              const pulls = Context.get(context, ThreadPulls.ThreadPulls);
              yield* pulls.begin(owner, {
                driveId: DRIVE,
                operationId: "pull",
                target: f.target,
                branch: worktree.branch,
              });
              const work = yield* runner.work;
              const before = yield* Clock.currentTimeMillis;
              yield* TestClock.adjust(IDLE_TAIL_MS + 1);
              expect((yield* runner.reconcile).busy).toBe(true);
              expect((yield* runner.work).needsUpkeep).toBe(false);
              expect(yield* Clock.currentTimeMillis).toBeGreaterThan(before);
              permitted = false;
              expect((yield* runner.authorizeRemote(work.pull!.drive.remoteToken!))._tag).toBe(
                "denied",
              );
              expect((yield* runner.authorizeDrive(work.pull!.drive.token))._tag).toBe("denied");
              expect(
                (yield* Context.get(context, PullState.PullState).pending)?.operation.target,
              ).toBe(f.target);
              expect((yield* runner.reconcile).release).not.toBeNull();
              expect(yield* Context.get(context, PullState.PullState).pending).toBeNull();
              expect((yield* pulls.wait(owner, "pull")).outcome).toBe("refused");
              expect((yield* runner.authorizeDrive(work.pull!.drive.token))._tag).toBe("denied");
            }),
          { drives: true, driveDirectory: f.directory, writes: () => Effect.succeed(permitted) },
        );
      }),
  );
});
