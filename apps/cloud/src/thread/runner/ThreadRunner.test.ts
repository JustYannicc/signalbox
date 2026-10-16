import { type RunnerItem } from "@signalbox/runner-protocol/RunnerProtocol";
import { CommandId, MessageId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { PERSONAL_CONTEXT_ID, SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import { OnePasswordEnvironmentId } from "@t3tools/contracts/signalboxFolders";
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { UserObjectError } from "../../user/UserDirectory.ts";
import { HARNESS_MODES_UNSUPPORTED } from "../threadDecider.ts";
import { CONNECT_TIMEOUT_MS, IDLE_TAIL_MS } from "./MachineBackend.ts";
import { CONTINUE_PROMPT, MAX_CONTINUATIONS } from "./runRecovery.ts";
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
  saveSession,
  send,
  snapshot,
  threadId,
  turnReport,
  withObject,
} from "./runnerTestKit.ts";

const POOL_CLAUDE = {
  instanceId: ProviderInstanceId.make("claude_hub"),
  model: "claude-fable-5-1",
};

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

  it.effect("says in the live turn when its pool moved the thread to another account", () =>
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

        yield* runner.accountMoved(turn.runId, "This thread's account hit its usage limit.");
        const notices = (yield* snapshot(engine)).projection.turnItems.filter(
          (item) => item.type === "system_notice",
        );
        expect(notices).toMatchObject([
          { title: "Account", message: "This thread's account hit its usage limit." },
        ]);

        // A move reported after the turn ended belongs to no transcript.
        yield* runner.batch({
          generation: machine.generation,
          sequence: 2,
          items: [report.full, report.terminal],
        });
        yield* runner.accountMoved(turn.runId, "Late.");
        const after = (yield* snapshot(engine)).projection.turnItems;
        expect(after.filter((item) => item.type === "system_notice")).toHaveLength(1);
      }),
    ),
  );

  it.effect("resumes the harness's own session when the next message lands on a new machine", () =>
    withObject(freshDatabase(), (engine, runner, context) =>
      Effect.gen(function* () {
        // As in the cloud: the thread runs on a pool's instance, the Runner on the harness's.
        yield* launch(engine, "launch-1", personal, ProjectId.make("scratch"), POOL_CLAUDE);
        const first = yield* connect(runner);
        const turn = yield* liveTurn(runner);
        const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
        // The adapter reports its provider thread as the Runner named it: on the harness's instance.
        const threadUpdated: RunnerItem = {
          kind: "provider",
          runId: turn.runId,
          event: {
            driver: claudeDriver,
            type: "provider_thread.updated",
            providerThread: encodeProviderThread({
              ...turn.providerThread,
              nativeThreadRef: {
                driver: claudeDriver,
                nativeId: "claude-session-1",
                strength: "strong",
              },
            }),
          },
        };
        yield* runner.batch({
          generation: first.generation,
          sequence: 1,
          items: [report.started, threadUpdated, report.full, report.terminal],
        });
        yield* saveSession(context, "claude-session-1");
        yield* runner.ended(first.generation, "test");
        yield* send(engine, 2, "Again");
        yield* connect(runner);
        // The next machine resumes the session the first one wrote, not a new one.
        expect(yield* liveTurn(runner)).toMatchObject({
          providerTurnOrdinal: 2,
          providerThread: { nativeThreadRef: { nativeId: "claude-session-1" } },
        });
      }),
    ),
  );

  it.effect("starts a new harness session when the thread holds none to resume", () =>
    withObject(freshDatabase(), (engine, runner) =>
      Effect.gen(function* () {
        yield* launch(engine, "launch-1", personal, ProjectId.make("scratch"), POOL_CLAUDE);
        const first = yield* connect(runner);
        const turn = yield* liveTurn(runner);
        const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
        // A harness that never said which session it wrote (or a thread whose
        // record lost it): the next turn has nothing to resume.
        const started = {
          ...report.started,
          providerThread: { ...report.started.providerThread, nativeThreadRef: null },
        } satisfies RunnerItem;
        yield* runner.batch({
          generation: first.generation,
          sequence: 1,
          items: [started, report.full, report.terminal],
        });
        yield* runner.ended(first.generation, "test");
        yield* send(engine, 2, "Again");
        yield* connect(runner);
        expect(yield* liveTurn(runner)).toMatchObject({
          providerTurnOrdinal: 1,
          providerThread: { nativeThreadRef: null },
        });
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
        yield* send(engine, 2, "Again");
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

          // The grant names the same trace the Runner was handed with the turn, and
          // sends it to the owner's pool: a thread from before pools uses Personal.
          expect(turn.traceId).toMatch(/^[0-9a-f]{32}$/);
          expect(yield* runner.authorizeModel(token, "anthropic")).toEqual({
            _tag: "granted",
            runId: turn.runId,
            traceId: turn.traceId,
            pool: { objectName: `${owner.userId}:personal`, userId: owner.userId },
            secrets: [],
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

  it.effect("hands the Runner a pool turn as its harness, and the gateway the resolved pool", () =>
    withObject(freshDatabase(), (engine, runner) =>
      Effect.gen(function* () {
        // The client names `lab`; the thread's chain resolves to `work`, which wins.
        yield* engine.launch(
          owner,
          {
            commandId: CommandId.make("launch-pool"),
            threadId,
            projectId: ProjectId.make("scratch"),
            title: "On a pool",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex_hub_lab"),
              model: "gpt-6-luna",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            workspaceStrategy: { type: "root" },
            initialMessage: { messageId: MessageId.make("message-1"), text: "Hi", attachments: [] },
          },
          { ...personal, pools: { top: "personal", projects: { scratch: "work" } } },
        );
        yield* connect(runner);
        const work = yield* runner.work;
        expect(work.turn?.modelSelection.instanceId).toBe("codex");
        expect(work.turn?.providerThread.providerInstanceId).toBe("codex");
        const granted = yield* runner.authorizeModel(work.modelToken ?? "", "openai");
        expect(granted).toMatchObject({
          _tag: "granted",
          pool: { objectName: `${owner.userId}:work`, userId: owner.userId },
        });
      }),
    ),
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
        expect(idle.wakeAt).toBe(IDLE_TAIL_MS);
        yield* TestClock.adjust(IDLE_TAIL_MS);
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

  it.effect("continues a run whose machine is lost on a new machine, from the same session", () =>
    withObject(freshDatabase(), (engine, runner, context) =>
      Effect.gen(function* () {
        yield* launch(engine);
        const machine = yield* connect(runner);
        const turn = yield* liveTurn(runner);
        const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
        yield* runner.batch({
          generation: machine.generation,
          sequence: 1,
          items: [report.started, report.partial],
        });
        yield* saveSession(context, "claude-session-1");
        // The machine is killed: its socket drops and never comes back.
        yield* runner.disconnected({
          generation: machine.generation,
          connection: 1,
          detail: "1006",
        });
        yield* TestClock.adjust(60_000);
        // The continuation needs a machine: the object looks again at once.
        expect(yield* runner.reconcile).toMatchObject({
          release: machine.generation,
          stop: true,
          wakeAt: 60_000,
        });

        const { projection } = yield* snapshot(engine);
        expect(projection.runs.map((run) => run.status)).toEqual(["interrupted", "starting"]);
        const [cut, continuation] = projection.runs;
        expect(continuation?.restartContinuationOfRunId).toBe(cut?.id);
        // The reply that was streaming is shown aborted, with why.
        const items = projection.turnItems.filter((item) => item.runId === cut?.id);
        expect(items.find((item) => item.type === "assistant_message")).toMatchObject({
          status: "interrupted",
          streaming: false,
          text: "Hel",
        });
        expect(items.some((item) => item.type === "system_notice")).toBe(true);

        // A new machine takes the continuation and resumes the harness's own session.
        const next = yield* connect(runner);
        expect(next.generation).toBe(machine.generation + 1);
        const work = yield* runner.work;
        expect(work.turn).toMatchObject({
          runId: continuation?.id,
          restartContinuationOfRunId: cut?.id,
          providerTurnOrdinal: 2,
          message: { text: CONTINUE_PROMPT, createdBy: "agent" },
          providerThread: { nativeThreadRef: { nativeId: "claude-session-1" } },
        });
        expect(work.sessions?.token).toMatch(/^sbs1\./);
        // The lost machine can never write to the thread again.
        expect(yield* runner.hello(hello(machine.generation, machine.token))).toMatchObject({
          reason: "stale_generation",
        });
      }),
    ),
  );

  it.effect(
    "starts a fresh session with the transcript when the lost machine saved none of it",
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
            items: [report.started, report.partial],
          });
          // Killed mid first turn, before the harness saved a row of its session (#465).
          yield* runner.disconnected({
            generation: machine.generation,
            connection: 1,
            detail: "1006",
          });
          yield* TestClock.adjust(60_000);
          yield* runner.reconcile;

          yield* connect(runner);
          const next = yield* liveTurn(runner);
          // Nothing to resume: a new session, told what the thread said so far.
          expect(next).toMatchObject({
            providerTurnOrdinal: 1,
            providerThread: { nativeThreadRef: null },
          });
          expect(next.restartContinuationOfRunId).toBeUndefined();
          expect(next.message.text).toContain("User:\nHi\n\nAssistant:\nHel\n\n");
          expect(next.message.text.endsWith(`User message:\n${CONTINUE_PROMPT}`)).toBe(true);
        }),
      ),
  );

  it.effect("answers in a fresh session once the one a thread names was never saved", () =>
    withObject(freshDatabase(), (engine, runner, context) =>
      Effect.gen(function* () {
        yield* launch(engine);
        const first = yield* connect(runner);
        const turn = yield* liveTurn(runner);
        const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
        // The thread names claude-session-1, but none of it reached the store.
        yield* runner.batch({
          generation: first.generation,
          sequence: 1,
          items: [report.started, report.full, report.terminal],
        });
        yield* runner.ended(first.generation, "test");
        yield* send(engine, 2, "Again");
        const second = yield* connect(runner);
        const fresh = yield* liveTurn(runner);
        expect(fresh).toMatchObject({
          providerTurnOrdinal: 1,
          providerThread: { nativeThreadRef: null },
        });
        expect(fresh.message.text).toContain("User:\nHi\n\nAssistant:\nHello!\n\n");
        expect(fresh.message.text.endsWith("User message:\nAgain")).toBe(true);

        // The fresh session is the one the thread resumes from then on.
        const freshReport = turnReport(fresh.runId, fresh.runOrdinal, fresh.providerThread);
        yield* runner.batch({
          generation: second.generation,
          sequence: 1,
          items: [
            {
              ...freshReport.started,
              providerThread: {
                ...freshReport.started.providerThread,
                nativeThreadRef: {
                  driver: claudeDriver,
                  nativeId: "claude-session-2",
                  strength: "strong",
                },
              },
            },
            freshReport.full,
            freshReport.terminal,
          ],
        });
        yield* saveSession(context, "claude-session-2");
        yield* runner.ended(second.generation, "test");
        yield* send(engine, 3, "Once more");
        yield* connect(runner);
        const resumed = yield* liveTurn(runner);
        expect(resumed).toMatchObject({
          providerTurnOrdinal: 3,
          providerThread: { nativeThreadRef: { nativeId: "claude-session-2" } },
          message: { text: "Once more" },
        });
      }),
    ),
  );

  it.effect("fails a run whose machines keep going away, or that never started", () =>
    withObject(freshDatabase(), (engine, runner) =>
      Effect.gen(function* () {
        yield* launch(engine);
        for (let lost = 0; lost <= MAX_CONTINUATIONS; lost++) {
          const machine = yield* connect(runner);
          const turn = yield* liveTurn(runner);
          const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
          yield* runner.batch({
            generation: machine.generation,
            sequence: 1,
            items: [report.started],
          });
          yield* runner.ended(machine.generation, "test");
        }
        const lostRuns = yield* snapshot(engine);
        expect(lostRuns.projection.runs.map((run) => run.status)).toEqual([
          ...Array.from({ length: MAX_CONTINUATIONS }, () => "interrupted"),
          "failed",
        ]);
        expect(lostRuns.projection.providerThreads[0]?.status).toBe("idle");
        expect(lostRuns.projection.turnItems.find((item) => item.type === "error")).toMatchObject({
          failure: { message: "Lost the machine running this turn." },
        });

        // A machine lost before the harness took the next message: nothing to resume.
        yield* send(engine, 2, "Again");
        const machine = yield* connect(runner);
        yield* runner.ended(machine.generation, "test");
        const { projection } = yield* snapshot(engine);
        expect(projection.runs.at(-1)?.status).toBe("failed");
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

  it.effect("stops a machine's drive calls once its owner can't change the thread's drive", () => {
    const design = "shared/org_acme/design";
    let access: "writes" | "removed" | "unreachable" = "writes";
    const acme = SignalboxContextId.make("org_acme");
    const member = { userId: "user_1", contextIds: [PERSONAL_CONTEXT_ID, acme] };
    return withObject(
      freshDatabase(),
      (engine, runner) =>
        Effect.gen(function* () {
          yield* engine.launch(
            member,
            {
              commandId: CommandId.make("launch-design"),
              threadId,
              projectId: ProjectId.make(`drive:${design}`),
              title: "In a shared drive",
              modelSelection: claude,
              runtimeMode: "full-access",
              interactionMode: "default",
              workspaceStrategy: { type: "root" },
              initialMessage: {
                messageId: MessageId.make("message-1"),
                text: "Hi",
                attachments: [],
              },
            },
            { place: { contextId: acme, driveId: design }, pools: personal.pools },
          );
          yield* connect(runner);
          const work = yield* runner.work;
          expect(work.drive?.driveId).toBe(design);
          const token = work.drive!.token;
          expect(yield* runner.authorizeDrive(token)).toMatchObject({
            _tag: "granted",
            driveId: design,
            userId: "user_1",
          });
          access = "unreachable";
          expect(yield* runner.authorizeDrive(token)).toEqual({ _tag: "unavailable" });
          access = "removed";
          expect(yield* runner.authorizeDrive(token)).toEqual({
            _tag: "denied",
            reason: "You no longer have access to change this drive.",
          });
        }),
      {
        drives: true,
        writes: (userId, driveId) => {
          expect([userId, driveId]).toEqual(["user_1", design]);
          return access === "unreachable"
            ? Effect.fail(new UserObjectError({ operation: "driveAccess", cause: "down" }))
            : Effect.succeed(access === "writes");
        },
      },
    );
  });

  it.effect("hands the machine the folder instructions its turn was started with", () =>
    withObject(
      freshDatabase(),
      (engine, runner) =>
        Effect.gen(function* () {
          const levels = [
            { label: "Top level", text: "Be brief." },
            { label: "Work", text: "End every reply with BANANA." },
          ];
          // What the owner's object resolved for this thread's home (`UserFolders.turn`).
          yield* launch(engine, "launch-1", {
            ...personal,
            instructions: { top: [], projects: {}, thread: levels },
          });
          yield* connect(runner);
          const work = yield* runner.work;
          expect(work.drive?.instructions).toEqual(levels);
        }),
      { drives: true },
    ),
  );

  it.effect(
    "hands the turn its folders' 1Password Environments with the owner's current token",
    () => {
      let token: string | null = "ops_first-token";
      const asked: Array<string> = [];
      const environments = [
        OnePasswordEnvironmentId.make("env-top"),
        OnePasswordEnvironmentId.make("env-work"),
      ];
      return withObject(
        freshDatabase(),
        (engine, runner) =>
          Effect.gen(function* () {
            // What the owner's object resolved for this thread's home (`UserFolders.turn`).
            yield* launch(engine, "launch-1", {
              ...personal,
              secrets: { top: [], projects: {}, thread: environments },
            });
            const machine = yield* connect(runner);
            expect((yield* runner.work).secrets).toEqual(environments);
            // Only a turn's hand-out asks the owner's object, not every look at the work.
            expect(asked).toEqual([]);
            expect(yield* runner.secretsToken).toBe("ops_first-token");
            // Replaced in the owner's object: the next hand-out has it, with no new run.
            token = "ops_replaced-token";
            expect(yield* runner.secretsToken).toBe("ops_replaced-token");
            expect(asked).toEqual(["user_1", "user_1"]);
            // Disconnected: the Environments still go, without a token to read them.
            token = null;
            expect(yield* runner.secretsToken).toBeNull();

            // What the Runner couldn't load shows in the turn; once started, nothing is handed out.
            const turn = yield* liveTurn(runner);
            const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
            yield* runner.batch({
              generation: machine.generation,
              sequence: 1,
              items: [
                report.started,
                {
                  kind: "secrets.notice",
                  runId: turn.runId,
                  message:
                    "No 1Password account is connected, so env-top and env-work weren't loaded.",
                },
              ],
            });
            expect((yield* runner.work).secrets).toEqual([]);
            const notice = (yield* snapshot(engine)).projection.turnItems.find(
              (item) => item.id === `turn-item:${turn.runId}:secrets`,
            );
            expect(notice).toMatchObject({
              type: "system_notice",
              title: "Secrets",
              message: "No 1Password account is connected, so env-top and env-work weren't loaded.",
            });
          }),
        {
          drives: true,
          secretsToken: (userId) =>
            Effect.sync(() => {
              asked.push(userId);
              return token;
            }),
        },
      );
    },
  );

  it.effect("hands out no secrets when the chain names none", () => {
    let asked = 0;
    return withObject(
      freshDatabase(),
      (engine, runner) =>
        Effect.gen(function* () {
          yield* launch(engine, "launch-1", {
            ...personal,
            secrets: { top: [], projects: {} },
          });
          yield* connect(runner);
          const work = yield* runner.work;
          expect(work.turn).not.toBeNull();
          expect(work.secrets).toEqual([]);
          expect(asked).toBe(0);
        }),
      {
        secretsToken: () =>
          Effect.sync(() => {
            asked += 1;
            return "ops_unused";
          }),
      },
    );
  });

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
            userId: "user_1",
            driveId: "my/personal/user_1",
            generation: machine.generation,
            live: true,
          });
          expect((yield* runner.authorizeDrive(`${token}x`))._tag).toBe("denied");
          expect((yield* runner.authorizeDrive(machine.token))._tag).toBe("denied");
          // My Drive is its own home, but a shortcut in it may show a drive with a remote (#142).
          expect(yield* runner.authorizeRemote(work.drive!.remoteToken!)).toMatchObject({
            _tag: "granted",
            driveId: "my/personal/user_1",
          });

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
          yield* launch(engine, "launch-1", {
            place: { contextId: PERSONAL_CONTEXT_ID, driveId: "shared/personal/repo1" },
            pools: personal.pools,
          });
          const machine = yield* connect(runner);
          const work = yield* runner.work;
          expect(work.drive?.driveId).toBe("shared/personal/repo1");
          const remoteToken = work.drive!.remoteToken!;
          expect(yield* runner.authorizeRemote(remoteToken)).toEqual({
            _tag: "granted",
            threadId,
            driveId: "shared/personal/repo1",
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

  it.effect(
    "signs the turn's commits as the owner's GitHub account, or leaves the fallback",
    () => {
      const octo = { name: "Octo Cat", email: "1+octo@users.noreply.github.com" };
      let author: "connected" | "none" | "unreachable" = "connected";
      return withObject(
        freshDatabase(),
        (engine, runner) =>
          Effect.gen(function* () {
            yield* launch(engine);
            expect(yield* runner.commitAuthor).toEqual(octo);
            author = "none";
            expect(yield* runner.commitAuthor).toBeNull();
            // A turn doesn't wait on the owner's object: it starts with the fallback.
            author = "unreachable";
            expect(yield* runner.commitAuthor).toBeNull();
          }),
        {
          drives: true,
          commitAuthor: (userId) => {
            expect(userId).toBe("user_1");
            if (author === "unreachable") {
              return Effect.fail(
                new UserObjectError({ operation: "githubCommitAuthor", cause: "down" }),
              );
            }
            return Effect.succeed(author === "connected" ? octo : null);
          },
        },
      );
    },
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
          expect((yield* runner.reconcile).wakeAt).toBe(IDLE_TAIL_MS);
          // A browser opens the preview's HMR socket: the tail is off, the TTL kept pushed out.
          previews.held = true;
          expect((yield* runner.work).needsUpkeep).toBe(true);
          expect(yield* runner.reconcile).toMatchObject({
            busy: true,
            release: null,
            wakeAt: null,
          });
          yield* TestClock.adjust(IDLE_TAIL_MS * 3);
          expect(yield* runner.reconcile).toMatchObject({ busy: true, release: null });
          expect((yield* runner.work).needsUpkeep).toBe(false);
          // The last preview closes: the tail starts over from then.
          previews.held = false;
          const closedAt = yield* Clock.currentTimeMillis;
          previews.lastActiveAt = closedAt;
          expect((yield* runner.work).needsUpkeep).toBe(true);
          expect((yield* runner.reconcile).wakeAt).toBe(closedAt + IDLE_TAIL_MS);
          // A late request pushes it out without holding the machine.
          yield* TestClock.adjust(IDLE_TAIL_MS - 1);
          previews.lastActiveAt = yield* Clock.currentTimeMillis;
          const pushed = yield* runner.reconcile;
          expect(pushed).toMatchObject({ release: null, busy: false });
          expect(pushed.wakeAt).toBe(previews.lastActiveAt + IDLE_TAIL_MS);
          yield* TestClock.adjust(IDLE_TAIL_MS);
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
