import { type RunnerItem } from "@signalbox/runner-protocol/RunnerProtocol";
import { CommandId, MessageId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { HARNESS_MODES_UNSUPPORTED } from "../threadDecider.ts";
import { CONNECT_TIMEOUT_MS } from "./MachineBackend.ts";
import {
  claude,
  claudeDriver,
  connect,
  encodeProviderThread,
  freshDatabase,
  hello,
  launch,
  liveTurn,
  owner,
  personal,
  type Previews,
  snapshot,
  threadId,
  turnReport,
  withObject,
} from "./runnerTestKit.ts";
import * as ThreadRunner from "./ThreadRunner.ts";

describe("ThreadRunner", () => {
  it.effect("answers for a thread that does not exist without touching storage", () =>
    withObject(freshDatabase(), (_engine, runner) =>
      Effect.gen(function* () {
        expect(yield* runner.work).toMatchObject({ needsUpkeep: false, turn: null });
        expect((yield* runner.reconcile).ensure).toBeNull();
        expect(yield* runner.hello(hello(1, "token"))).toMatchObject({ reason: "unknown_thread" });
      }),
    ),
  );

  it.effect("streams a Runner's turn into the thread and starts nothing twice", () =>
    withObject(freshDatabase(), (engine, runner) =>
      Effect.gen(function* () {
        yield* launch(engine);
        const machine = yield* connect(runner);
        const turn = yield* liveTurn(runner);
        expect(turn.providerThread.nativeThreadRef).toBeNull();
        expect(turn.message.text).toBe("Hi");
        const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
        const batch = (sequence: number, items: ReadonlyArray<RunnerItem>) =>
          runner.batch({ generation: machine.generation, sequence, items });

        expect(yield* batch(1, [report.started])).toEqual({ _tag: "ack", sequence: 1 });
        // Started: no turn left to hand out.
        expect((yield* runner.work).turn).toBeNull();
        expect(yield* batch(2, [report.partial])).toEqual({ _tag: "ack", sequence: 2 });
        const midTurn = yield* snapshot(engine);

        // The socket dropped before the ack arrived: the Runner resends batch 2.
        expect(yield* batch(2, [report.partial])).toEqual({ _tag: "ack", sequence: 2 });
        expect((yield* snapshot(engine)).head).toBe(midTurn.head);
        // A gap is never applied.
        expect(yield* batch(4, [report.full])).toEqual({ _tag: "out_of_order", ackedSequence: 2 });

        yield* batch(3, [report.full, report.terminal]);
        const { projection } = yield* snapshot(engine);
        expect(projection.runs.map((run) => run.status)).toEqual(["completed"]);
        expect(projection.providerThreads[0]?.nativeThreadRef?.nativeId).toBe("claude-session-1");
        expect(projection.providerThreads[0]?.status).toBe("idle");
        const rows = projection.visibleTurnItems.map(({ item }) => item);
        expect(rows.map((item) => item.type)).toEqual(["user_message", "assistant_message"]);
        expect(rows.map((item) => item.ordinal)).toEqual([1_000_000, 1_000_001]);
        expect(rows[1]).toMatchObject({ text: "Hello!", status: "completed" });
      }),
    ),
  );

  it.effect("keeps acknowledged batches across an eviction", () =>
    Effect.gen(function* () {
      const filename = freshDatabase();
      const { machine, turn, head } = yield* withObject(filename, (engine, runner) =>
        Effect.gen(function* () {
          yield* launch(engine);
          const machine = yield* connect(runner);
          const turn = yield* liveTurn(runner);
          const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
          yield* runner.batch({
            generation: machine.generation,
            sequence: 1,
            items: [report.started],
          });
          yield* runner.batch({
            generation: machine.generation,
            sequence: 2,
            items: [report.partial],
          });
          return { machine, turn, head: (yield* snapshot(engine)).head };
        }),
      );
      yield* withObject(filename, (engine, runner) =>
        Effect.gen(function* () {
          const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
          const welcome = yield* runner.hello(hello(machine.generation, machine.token));
          expect(welcome).toMatchObject({
            _tag: "welcome",
            ackedSequence: 2,
            activeRunId: turn.runId,
          });
          // Everything the Runner still holds is resent; only what is new lands.
          for (const [sequence, items] of [
            [1, [report.started]],
            [2, [report.partial]],
          ] as const) {
            yield* runner.batch({ generation: machine.generation, sequence, items });
          }
          expect((yield* snapshot(engine)).head).toBe(head);
          yield* runner.batch({
            generation: machine.generation,
            sequence: 3,
            items: [report.full, report.terminal],
          });
          const { projection } = yield* snapshot(engine);
          expect(projection.runs.map((run) => run.status)).toEqual(["completed"]);
          expect(
            projection.turnItems.filter((item) => item.type === "assistant_message"),
          ).toHaveLength(1);
        }),
      );
    }),
  );

  it.effect("refuses a Runner from an older generation", () =>
    withObject(freshDatabase(), (engine, runner) =>
      Effect.gen(function* () {
        yield* launch(engine);
        const first = yield* connect(runner);
        const turn = yield* liveTurn(runner);
        const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
        yield* runner.batch({
          generation: first.generation,
          sequence: 1,
          items: [report.started, report.full, report.terminal],
        });
        // The machine went away; the next message gets a new one.
        yield* runner.ended(first.generation, "test");
        yield* engine.dispatch(
          owner,
          {
            type: "message.dispatch",
            commandId: CommandId.make("send-2"),
            createdBy: "user",
            creationSource: "web",
            threadId,
            messageId: MessageId.make("message-2"),
            text: "Again",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            deliveryIntent: "auto",
          },
          personal,
        );
        const second = yield* connect(runner);
        expect(second.generation).toBe(first.generation + 1);

        expect(yield* runner.hello(hello(first.generation, first.token))).toMatchObject({
          _tag: "refused",
          reason: "stale_generation",
        });
        expect(yield* runner.hello(hello(second.generation, first.token))).toMatchObject({
          _tag: "refused",
          reason: "bad_token",
        });
        expect(yield* runner.hello(hello(second.generation + 1, second.token))).toMatchObject({
          _tag: "refused",
          reason: "unknown_generation",
        });
        // A socket left over from the old generation cannot write either.
        expect(
          yield* runner.batch({ generation: first.generation, sequence: 2, items: [report.full] }),
        ).toEqual({ _tag: "stale" });
      }),
    ),
  );

  it.effect("grants model requests only with the running turn's token", () =>
    Effect.gen(function* () {
      const tokenElsewhere = yield* withObject(freshDatabase(), (engine, runner) =>
        Effect.gen(function* () {
          yield* launch(engine);
          yield* connect(runner);
          return (yield* runner.work).modelToken ?? "";
        }),
      );
      yield* withObject(freshDatabase(), (engine, runner) =>
        Effect.gen(function* () {
          yield* launch(engine);
          const machine = yield* connect(runner);
          const work = yield* runner.work;
          const turn = yield* liveTurn(runner);
          const token = work.modelToken ?? "";
          expect(token).toMatch(/^sbm1\./);

          // The grant names the same trace the Runner was handed with the turn.
          expect(turn.traceId).toMatch(/^[0-9a-f]{32}$/);
          expect(yield* runner.authorizeModel(token, "anthropic")).toEqual({
            _tag: "granted",
            runId: turn.runId,
            traceId: turn.traceId,
          });
          // Claude's turn, so not Codex's API; and nothing but the exact token.
          expect((yield* runner.authorizeModel(token, "openai"))._tag).toBe("denied");
          expect((yield* runner.authorizeModel(`${token}x`, "anthropic"))._tag).toBe("denied");
          // The same thread on another machine lease: a different token.
          expect((yield* runner.authorizeModel(tokenElsewhere, "anthropic"))._tag).toBe("denied");

          const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
          yield* runner.batch({
            generation: machine.generation,
            sequence: 1,
            items: [report.started, report.full, report.terminal],
          });
          expect(yield* runner.authorizeModel(token, "anthropic")).toEqual({
            _tag: "denied",
            reason: "No turn is running on this thread.",
          });

          yield* engine.dispatch(
            owner,
            {
              type: "message.dispatch",
              commandId: CommandId.make("send-2"),
              createdBy: "user",
              creationSource: "web",
              threadId,
              messageId: MessageId.make("message-2"),
              text: "Again",
              attachments: [],
              dispatchMode: { type: "start_immediately" },
              deliveryIntent: "auto",
            },
            personal,
          );
          const next = yield* runner.work;
          const nextToken = next.modelToken ?? "";
          expect(next.turn?.runId).not.toBe(turn.runId);
          expect(nextToken).not.toBe(token);
          // The machine is the same, the turn is not: the ended turn's token stays dead.
          expect((yield* runner.authorizeModel(token, "anthropic"))._tag).toBe("denied");
          expect((yield* runner.authorizeModel(nextToken, "anthropic"))._tag).toBe("granted");

          // Releasing the machine ends every token it held.
          yield* runner.ended(machine.generation, "test");
          expect((yield* runner.authorizeModel(nextToken, "anthropic"))._tag).toBe("denied");
        }),
      );
    }),
  );

  it.effect("fails the run when no machine connects, and lets the next message try again", () =>
    withObject(freshDatabase(), (engine, runner) =>
      Effect.gen(function* () {
        yield* launch(engine);
        const plan = yield* runner.reconcile;
        expect(plan.ensure?.generation).toBe(1);
        yield* TestClock.adjust(CONNECT_TIMEOUT_MS + 1);
        const timedOut = yield* runner.reconcile;
        expect(timedOut).toMatchObject({ release: 1, stop: true });

        const { projection } = yield* snapshot(engine);
        expect(projection.runs.map((run) => run.status)).toEqual(["failed"]);
        const error = projection.turnItems.find((item) => item.type === "error");
        expect(error).toMatchObject({
          failure: { message: "No machine came up to run this turn." },
        });
        expect(yield* runner.hello(hello(1, plan.ensure?.token ?? ""))).toMatchObject({
          reason: "stale_generation",
        });
      }),
    ),
  );

  it.effect("releases an idle machine after its tail", () =>
    withObject(freshDatabase(), (engine, runner) =>
      Effect.gen(function* () {
        yield* launch(engine);
        const machine = yield* connect(runner);
        const turn = yield* liveTurn(runner);
        // While the turn runs, the machine is busy: its TTL is kept pushed out.
        expect(yield* runner.reconcile).toMatchObject({ busy: true, stop: false });
        const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
        yield* runner.batch({
          generation: machine.generation,
          sequence: 1,
          items: [report.started, report.full, report.terminal],
        });
        const idle = yield* runner.reconcile;
        expect(idle).toMatchObject({ release: null, stop: false });
        expect(idle.wakeAt).toBe(ThreadRunner.IDLE_TAIL_MS);
        yield* TestClock.adjust(ThreadRunner.IDLE_TAIL_MS);
        // The machine stops with the lease, and stays stopped until the next run.
        expect(yield* runner.reconcile).toMatchObject({ release: machine.generation, stop: true });
        expect((yield* runner.work).needsUpkeep).toBe(false);
        expect(yield* runner.reconcile).toMatchObject({ ensure: null, stop: true });
      }),
    ),
  );

  it.effect("ignores the late close of a connection a reconnect replaced", () =>
    withObject(freshDatabase(), (engine, runner) =>
      Effect.gen(function* () {
        yield* launch(engine);
        const machine = yield* connect(runner);
        const again = yield* runner.hello(hello(machine.generation, machine.token));
        if (again._tag !== "welcome") throw new Error("expected a welcome");
        // The first socket's close arrives after the second said hello.
        yield* runner.disconnected({
          generation: machine.generation,
          connection: again.connection - 1,
          detail: "code 1006",
        });
        expect((yield* runner.work).needsUpkeep).toBe(false);
        yield* runner.disconnected({
          generation: machine.generation,
          connection: again.connection,
          detail: "code 1006",
        });
        expect((yield* runner.work).needsUpkeep).toBe(true);
      }),
    ),
  );

  it.effect(
    "fails the live run when its machine says end, and ignores the run's late session state",
    () =>
      withObject(freshDatabase(), (engine, runner) =>
        Effect.gen(function* () {
          yield* launch(engine);
          const machine = yield* connect(runner);
          const turn = yield* liveTurn(runner);
          const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
          yield* runner.batch({
            generation: machine.generation,
            sequence: 1,
            items: [report.started],
          });
          yield* runner.ended(machine.generation, "test");

          const ended = yield* snapshot(engine);
          expect(ended.projection.runs.map((run) => run.status)).toEqual(["failed"]);
          expect(ended.projection.providerThreads[0]?.status).toBe("idle");
          expect(yield* runner.hello(hello(machine.generation, machine.token))).toMatchObject({
            reason: "stale_generation",
          });
        }),
      ),
  );

  it.effect("records a stopped run's last rows but not its provider thread coming back", () =>
    withObject(freshDatabase(), (engine, runner) =>
      Effect.gen(function* () {
        yield* launch(engine);
        const machine = yield* connect(runner);
        const turn = yield* liveTurn(runner);
        const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
        yield* runner.batch({
          generation: machine.generation,
          sequence: 1,
          items: [report.started],
        });
        yield* engine.dispatch(
          owner,
          {
            type: "run.interrupt",
            commandId: CommandId.make("stop-1"),
            threadId,
            runId: turn.runId,
            holdQueue: true,
          },
          personal,
        );
        const lateThread: RunnerItem = {
          kind: "provider",
          runId: turn.runId,
          event: {
            type: "provider_thread.updated",
            driver: claudeDriver,
            providerThread: encodeProviderThread({
              ...turn.providerThread,
              status: "active",
            }),
          },
        };
        yield* runner.batch({
          generation: machine.generation,
          sequence: 2,
          items: [report.full, lateThread],
        });
        const { projection } = yield* snapshot(engine);
        expect(projection.runs.map((run) => run.status)).toEqual(["interrupted"]);
        expect(projection.providerThreads[0]?.status).toBe("idle");
        expect(
          projection.turnItems.find((item) => item.type === "assistant_message"),
        ).toMatchObject({ text: "Hello!" });
      }),
    ),
  );

  it.effect("refuses a Claude turn that could stop to ask for approval", () =>
    withObject(freshDatabase(), (engine) =>
      Effect.gen(function* () {
        const refused = yield* Effect.flip(
          engine.launch(
            owner,
            {
              commandId: CommandId.make("launch-approval"),
              threadId,
              projectId: ProjectId.make("scratch"),
              title: "Ask first",
              modelSelection: claude,
              runtimeMode: "approval-required",
              interactionMode: "default",
              workspaceStrategy: { type: "root" },
              initialMessage: {
                messageId: MessageId.make("message-1"),
                text: "Hi",
                attachments: [],
              },
            },
            personal,
          ),
        );
        expect(refused).toMatchObject({ reason: HARNESS_MODES_UNSUPPORTED });
      }),
    ),
  );

  it.effect("gives each machine a drive token that acts only for its own generation and turn", () =>
    withObject(
      freshDatabase(),
      (engine, runner) =>
        Effect.gen(function* () {
          yield* launch(engine);
          const machine = yield* connect(runner);
          const work = yield* runner.work;
          expect(work.drive?.driveId).toBe("my/personal/user_1");
          const token = work.drive!.token;
          expect(yield* runner.authorizeDrive(token)).toEqual({
            _tag: "granted",
            threadId,
            driveId: "my/personal/user_1",
            userId: "user_1",
            generation: machine.generation,
            live: true,
          });
          expect((yield* runner.authorizeDrive(`${token}x`))._tag).toBe("denied");
          expect((yield* runner.authorizeDrive(machine.token))._tag).toBe("denied");
          // My Drive is its own home: there is no remote to fetch.
          expect(work.drive!.remoteToken).toBeNull();

          const turn = yield* liveTurn(runner);
          const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
          const commit = "a".repeat(40);
          yield* runner.batch({
            generation: machine.generation,
            sequence: 1,
            items: [
              report.started,
              {
                kind: "drive.checkpoint",
                runId: turn.runId,
                start: null,
                commit,
                files: [{ path: "notes.md", kind: "added", additions: 3, deletions: 0 }],
              },
              { kind: "drive.notice", runId: turn.runId, message: "Merged main." },
              report.terminal,
            ],
          });
          const { projection } = yield* snapshot(engine);
          expect(projection.checkpoints).toMatchObject([
            {
              runId: turn.runId,
              appRunOrdinal: turn.runOrdinal,
              ref: `..${commit}`,
              status: "ready",
              files: [{ path: "notes.md", additions: 3 }],
            },
          ]);
          expect(
            projection.turnItems.filter((item) => item.type === "system_notice"),
          ).toMatchObject([{ message: "Merged main." }]);
          // The turn is over: main no longer moves for this token.
          expect(yield* runner.authorizeDrive(token)).toMatchObject({
            _tag: "granted",
            live: false,
          });
        }),
      { drives: true },
    ),
  );

  it.effect("gives a thread in an imported repository a remote token for its turn only", () =>
    withObject(
      freshDatabase(),
      (engine, runner) =>
        Effect.gen(function* () {
          yield* launch(engine, "launch-1", ProjectId.make("project-repo"));
          const machine = yield* connect(runner);
          const work = yield* runner.work;
          expect(work.drive?.driveId).toBe("project/user_1/project-repo");
          const remoteToken = work.drive!.remoteToken!;
          expect(yield* runner.authorizeRemote(remoteToken)).toEqual({
            _tag: "granted",
            threadId,
            driveId: "project/user_1/project-repo",
            userId: "user_1",
          });
          // Neither token stands in for the other.
          expect((yield* runner.authorizeRemote(work.drive!.token))._tag).toBe("denied");
          expect((yield* runner.authorizeDrive(remoteToken))._tag).toBe("denied");

          const turn = yield* liveTurn(runner);
          const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
          yield* runner.batch({
            generation: machine.generation,
            sequence: 1,
            items: [report.started, report.terminal],
          });
          expect(yield* runner.authorizeRemote(remoteToken)).toMatchObject({
            _tag: "denied",
            reason: "No turn is running on this thread.",
          });
        }),
      { drives: true },
    ),
  );

  it.effect("hands out no drive when the cloud stores none", () =>
    withObject(freshDatabase(), (engine, runner) =>
      Effect.gen(function* () {
        yield* launch(engine);
        yield* connect(runner);
        expect((yield* runner.work).drive).toBeNull();
        expect((yield* runner.authorizeDrive("sbd1.x.y"))._tag).toBe("denied");
      }),
    ),
  );

  it.effect("keeps a machine up while a preview is open, then tails from its last traffic", () => {
    const previews: Previews = { held: false, lastActiveAt: null };
    return withObject(
      freshDatabase(),
      (engine, runner) =>
        Effect.gen(function* () {
          yield* launch(engine);
          const machine = yield* connect(runner);
          const turn = yield* liveTurn(runner);
          const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
          yield* runner.batch({
            generation: machine.generation,
            sequence: 1,
            items: [report.started, report.full, report.terminal],
          });
          expect((yield* runner.reconcile).wakeAt).toBe(ThreadRunner.IDLE_TAIL_MS);
          // A browser opens the preview's HMR socket: the tail is off, the TTL kept pushed out.
          previews.held = true;
          expect((yield* runner.work).needsUpkeep).toBe(true);
          expect(yield* runner.reconcile).toMatchObject({
            busy: true,
            release: null,
            wakeAt: null,
          });
          yield* TestClock.adjust(ThreadRunner.IDLE_TAIL_MS * 3);
          expect(yield* runner.reconcile).toMatchObject({ busy: true, release: null });
          expect((yield* runner.work).needsUpkeep).toBe(false);
          // The last preview closes: the tail starts over from then.
          previews.held = false;
          const closedAt = yield* Clock.currentTimeMillis;
          previews.lastActiveAt = closedAt;
          expect((yield* runner.work).needsUpkeep).toBe(true);
          expect((yield* runner.reconcile).wakeAt).toBe(closedAt + ThreadRunner.IDLE_TAIL_MS);
          // A late request pushes it out without holding the machine.
          yield* TestClock.adjust(ThreadRunner.IDLE_TAIL_MS - 1);
          previews.lastActiveAt = yield* Clock.currentTimeMillis;
          const pushed = yield* runner.reconcile;
          expect(pushed).toMatchObject({ release: null, busy: false });
          expect(pushed.wakeAt).toBe(previews.lastActiveAt + ThreadRunner.IDLE_TAIL_MS);
          yield* TestClock.adjust(ThreadRunner.IDLE_TAIL_MS);
          expect(yield* runner.reconcile).toMatchObject({
            release: machine.generation,
            stop: true,
          });
          // A preview never starts a machine.
          previews.held = true;
          expect(yield* runner.reconcile).toMatchObject({ ensure: null, stop: true });
        }),
      { previews },
    );
  });

  it.effect("hands a preview tunnel the lease token only for the leased generation", () =>
    withObject(freshDatabase(), (engine, runner) =>
      Effect.gen(function* () {
        expect(yield* runner.leaseToken(1)).toBeNull();
        yield* launch(engine);
        const machine = yield* connect(runner);
        expect(yield* runner.leaseToken(machine.generation)).toBe(machine.token);
        expect(yield* runner.leaseToken(machine.generation, machine.token)).toBe(machine.token);
        expect(yield* runner.leaseToken(machine.generation, "wrong")).toBeNull();
        expect(yield* runner.leaseToken(machine.generation + 1)).toBeNull();
      }),
    ),
  );
});
