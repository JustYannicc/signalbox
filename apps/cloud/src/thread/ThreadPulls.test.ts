import type { PullResult } from "@signalbox/runner-protocol/PullProtocol";
import type { RunnerHello } from "@signalbox/runner-protocol/RunnerProtocol";
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { DriveDirectory, handleFor } from "../drive/DriveDirectory.ts";
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
    "sends one command per connection and sends it again after reconnect without changing target",
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
              expect((yield* send(engine, 2, "wait").pipe(Effect.result))._tag).toBe("Failure");
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
