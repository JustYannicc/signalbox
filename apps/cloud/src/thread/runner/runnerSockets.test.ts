import {
  CommandId,
  MessageId,
  ProviderSessionId,
  ProviderTurnId,
  RuntimeRequestId,
  type OrchestrationV2RuntimeRequest,
  type RunId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";

import type * as ThreadRunner from "./ThreadRunner.ts";
import {
  capabilities,
  claudeDriver,
  connect,
  type FakeSocket,
  fakeSocket,
  freshDatabase,
  hello,
  hostFor,
  launch,
  liveTurn,
  owner,
  personal,
  saveSession,
  send,
  snapshot,
  threadId,
  turnReport,
  withObject,
} from "./runnerTestKit.ts";
import { onRunnerMessage, pushRunnerWork, type RunnerSocketHost } from "./runnerSockets.ts";
import { unstampedEventId } from "../threadEvents.ts";

/**
 * The thread object's end of its Runner's socket, on in-memory sockets: what
 * each Runner connection is told as the thread changes.
 */

const say = (host: RunnerSocketHost, socket: FakeSocket, message: object) =>
  Effect.promise(() => onRunnerMessage(host, socket.socket, JSON.stringify(message)));

const steering = {
  ...capabilities,
  turns: { ...capabilities.turns, supportsActiveSteering: true },
};

/**
 * Launches the thread and connects a Runner over a socket, which takes the
 * turn and reports it started on a harness that steers. `steers`: whether
 * the Runner said it takes `steer`.
 */
const runningTurn = (
  engine: Parameters<Parameters<typeof withObject>[1]>[0],
  runner: ThreadRunner.ThreadRunner["Service"],
  steers: boolean,
  runtimeRequestResponses = false,
) =>
  Effect.gen(function* () {
    yield* launch(engine);
    const plan = yield* runner.reconcile;
    if (plan.ensure === null) throw new Error("expected a machine request");
    yield* runner.ensured(plan.ensure.generation);
    const sockets: Array<WebSocket> = [];
    const host = yield* hostFor(runner, sockets);
    const socket = fakeSocket();
    sockets.push(socket.socket);
    yield* say(host, socket, {
      ...hello(plan.ensure.generation, plan.ensure.token),
      takenRunIds: [],
      ...(steers ? { steers: true } : {}),
      ...(runtimeRequestResponses ? { runtimeRequestResponses: true } : {}),
    });
    const start = socket.sent.find((message) => message.type === "turn.start");
    if (start?.type !== "turn.start") throw new Error("expected the turn");
    const { turn } = start;
    const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
    // The harness took the turn and is running it.
    const providerTurn = {
      kind: "provider",
      runId: turn.runId,
      event: {
        type: "provider_turn.updated",
        driver: claudeDriver,
        providerTurn: {
          id: `claude-turn:${turn.runId}`,
          providerThreadId: turn.providerThread.id,
          nodeId: turn.rootNodeId,
          runAttemptId: turn.attemptId,
          nativeTurnRef: null,
          ordinal: 1,
          status: "running",
          startedAt: null,
          completedAt: null,
        },
      },
    };
    yield* say(host, socket, {
      type: "batch",
      sequence: 1,
      items: [
        {
          ...report.started,
          providerSession: { ...report.started.providerSession, capabilities: steering },
        },
        providerTurn,
      ],
    });
    socket.sent.length = 0;
    return {
      host,
      sockets,
      socket,
      turn,
      report,
      providerTurn,
      generation: plan.ensure.generation,
      token: plan.ensure.token,
    };
  });

/** As the object's `dispatch` does: decide, then hand the Runner what changed. */
const dispatched = <A, E>(host: RunnerSocketHost, dispatch: Effect.Effect<A, E>) =>
  Effect.tap(dispatch, () => Effect.promise(() => pushRunnerWork(host)));

const command = <T extends object>(type: string, fields: T) => ({
  type,
  commandId: CommandId.make(`${type}-${JSON.stringify(fields).length}`),
  threadId,
  ...fields,
});

describe("runnerSockets", () => {
  it.effect("replays committed native answers after socket reconnect and object restart", () =>
    Effect.gen(function* () {
      const filename = freshDatabase();
      const saved = yield* withObject(filename, (engine, runner) =>
        Effect.gen(function* () {
          const live = yield* runningTurn(engine, runner, false, true);
          const request: OrchestrationV2RuntimeRequest = {
            id: RuntimeRequestId.make("native-question"),
            nodeId: live.turn.rootNodeId,
            providerTurnId: ProviderTurnId.make(`claude-turn:${live.turn.runId}`),
            nativeRequestRef: null,
            kind: "user_input",
            status: "resolved",
            responseCapability: {
              type: "live",
              providerSessionId: ProviderSessionId.make("session-1"),
            },
            createdAt: DateTime.makeUnsafe(0),
            resolvedAt: DateTime.makeUnsafe(1),
            answers: { destination: "Zurich" },
          };
          // A committed decision, with no transport call: this also covers answering while disconnected.
          yield* engine.apply((_projection, ctx) =>
            Effect.succeed({
              events: [
                {
                  id: unstampedEventId,
                  threadId,
                  type: "runtime-request.updated",
                  occurredAt: ctx.now,
                  payload: request,
                },
              ],
              result: undefined,
            }),
          );
          const response = {
            runId: live.turn.runId,
            requestId: request.id,
            providerSessionId: ProviderSessionId.make("session-1"),
            providerTurnId: request.providerTurnId,
            answers: request.answers,
          };
          yield* Effect.promise(() => pushRunnerWork(live.host));
          expect(live.socket.sent).toEqual([{ type: "runtime-request.respond", response }]);
          yield* Effect.promise(() => pushRunnerWork(live.host));
          expect(live.socket.sent).toHaveLength(1);
          // Hibernation attachments store ids, never answer values.
          expect(JSON.stringify(live.socket.socket.deserializeAttachment())).not.toContain(
            "Zurich",
          );
          const again = fakeSocket();
          live.sockets.splice(0, live.sockets.length, again.socket);
          yield* say(live.host, again, {
            ...hello(live.generation, live.token),
            takenRunIds: [live.turn.runId],
            runtimeRequestResponses: true,
          });
          expect(
            again.sent.filter((message) => message.type === "runtime-request.respond"),
          ).toEqual([{ type: "runtime-request.respond", response }]);
          return { generation: live.generation, token: live.token, response };
        }),
      );
      // A new object has only persisted projection + lease, no delivery state in memory.
      yield* withObject(filename, (_engine, runner) =>
        Effect.gen(function* () {
          const socket = fakeSocket();
          const host = yield* hostFor(runner, [socket.socket]);
          yield* say(host, socket, {
            ...hello(saved.generation, saved.token),
            takenRunIds: [saved.response.runId],
            runtimeRequestResponses: true,
          });
          expect(
            socket.sent.filter((message) => message.type === "runtime-request.respond"),
          ).toEqual([{ type: "runtime-request.respond", response: saved.response }]);
        }),
      );
    }),
  );

  it.effect("keeps the additive response frame away from older v5 Runners", () =>
    withObject(freshDatabase(), (engine, runner) =>
      Effect.gen(function* () {
        const { host, socket, turn } = yield* runningTurn(engine, runner, false);
        yield* engine.apply((_projection, ctx) =>
          Effect.succeed({
            events: [
              {
                id: unstampedEventId,
                threadId,
                type: "runtime-request.updated",
                occurredAt: ctx.now,
                payload: {
                  id: RuntimeRequestId.make("approval"),
                  nodeId: turn.rootNodeId,
                  providerTurnId: ProviderTurnId.make(`claude-turn:${turn.runId}`),
                  nativeRequestRef: null,
                  kind: "command",
                  status: "resolved",
                  responseCapability: {
                    type: "live",
                    providerSessionId: ProviderSessionId.make("session-1"),
                  },
                  createdAt: ctx.now,
                  resolvedAt: ctx.now,
                  decision: "accept",
                },
              },
            ],
            result: undefined,
          }),
        );
        expect((yield* runner.work).runtimeResponses).toHaveLength(1);
        yield* Effect.promise(() => pushRunnerWork(host));
        expect(socket.sent).toEqual([]);
      }),
    ),
  );

  it.effect("never delivers pending, expired, message-only or stale-session native requests", () =>
    withObject(freshDatabase(), (engine, runner) =>
      Effect.gen(function* () {
        const { host, socket, turn } = yield* runningTurn(engine, runner, false, true);
        yield* engine.apply((_projection, ctx) => {
          const resolved: OrchestrationV2RuntimeRequest = {
            id: RuntimeRequestId.make("resolved"),
            nodeId: turn.rootNodeId,
            providerTurnId: ProviderTurnId.make(`claude-turn:${turn.runId}`),
            nativeRequestRef: null,
            kind: "user_input",
            status: "resolved",
            responseCapability: {
              type: "live",
              providerSessionId: ProviderSessionId.make("session-1"),
            },
            createdAt: ctx.now,
            resolvedAt: ctx.now,
            answers: { answer: "continue" },
          };
          const requests: ReadonlyArray<OrchestrationV2RuntimeRequest> = [
            { ...resolved, id: RuntimeRequestId.make("pending"), status: "pending" },
            { ...resolved, id: RuntimeRequestId.make("expired"), status: "expired" },
            {
              ...resolved,
              id: RuntimeRequestId.make("message"),
              responseCapability: { type: "message" },
            },
            {
              ...resolved,
              id: RuntimeRequestId.make("old-session"),
              responseCapability: {
                type: "live",
                providerSessionId: ProviderSessionId.make("old-session"),
              },
            },
            {
              ...resolved,
              id: RuntimeRequestId.make("old-turn"),
              providerTurnId: ProviderTurnId.make("old-turn"),
            },
            resolved,
          ];
          return Effect.succeed({
            events: requests.map((payload) => ({
              id: unstampedEventId,
              threadId,
              type: "runtime-request.updated" as const,
              occurredAt: ctx.now,
              payload,
            })),
            result: undefined,
          });
        });
        yield* Effect.promise(() => pushRunnerWork(host));
        expect(
          socket.sent
            .filter((message) => message.type === "runtime-request.respond")
            .map((message) => message.response.requestId),
        ).toEqual(["resolved"]);
      }),
    ),
  );

  it.effect("holds a waiting turn back while its pull requests are being read (#495)", () =>
    withObject(freshDatabase(), (engine, runner) =>
      Effect.gen(function* () {
        yield* launch(engine);
        const plan = yield* runner.reconcile;
        if (plan.ensure === null) throw new Error("expected a machine request");
        yield* runner.ensured(plan.ensure.generation);
        const sockets: Array<WebSocket> = [];
        let holds = true;
        const host = yield* hostFor(runner, sockets, () => holds);
        const socket = fakeSocket();
        sockets.push(socket.socket);
        yield* say(host, socket, {
          ...hello(plan.ensure.generation, plan.ensure.token),
          takenRunIds: [],
        });
        expect(socket.sent.map((message) => message.type)).toEqual(["welcome"]);

        // The reads are in: the next hand-out gives the turn.
        holds = false;
        yield* Effect.promise(() => pushRunnerWork(host));
        expect(socket.sent.map((message) => message.type)).toEqual(["welcome", "turn.start"]);
      }),
    ),
  );

  it.effect("stops a running turn on a Runner that reconnected while it ran", () =>
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

        // The socket the turn was handed on dropped (a deploy); the same Runner
        // process says hello again on a new one, still running the turn.
        const sockets: Array<WebSocket> = [];
        const host = yield* hostFor(runner, sockets);
        const again = fakeSocket();
        sockets.push(again.socket);
        yield* say(host, again, {
          ...hello(machine.generation, machine.token),
          lastAckedSequence: 1,
          takenRunIds: [turn.runId],
        });
        expect(again.sent.map((message) => message.type)).toEqual(["welcome"]);

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
        yield* Effect.promise(() => pushRunnerWork(host));

        expect(again.sent.slice(1)).toEqual([{ type: "interrupt", runId: turn.runId }]);
      }),
    ),
  );

  it.effect("steers a message into the running turn and hands it to the Runner once", () =>
    withObject(freshDatabase(), (engine, runner) =>
      Effect.gen(function* () {
        const { host, socket, turn } = yield* runningTurn(engine, runner, true);

        yield* dispatched(host, send(engine, 2, "Also check the tests"));
        const { projection } = yield* snapshot(engine);
        // No second run: the message joins the running one.
        expect(projection.runs.map((run) => [run.id, run.status])).toEqual([
          [turn.runId, "running"],
        ]);
        expect(projection.messages.find((message) => message.id === "message-2")).toMatchObject({
          runId: turn.runId,
          nodeId: turn.rootNodeId,
        });
        expect(
          projection.turnItems.find(
            (item) => item.type === "user_message" && item.messageId === "message-2",
          ),
        ).toMatchObject({ runId: turn.runId, inputIntent: "steer", text: "Also check the tests" });

        const steer = {
          type: "steer",
          runId: turn.runId,
          message: {
            messageId: MessageId.make("message-2"),
            text: "Also check the tests",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
        };
        expect(socket.sent).toEqual([steer]);
        // Told once per connection; a reconnect is told again, and the Runner takes it once.
        yield* Effect.promise(() => pushRunnerWork(host));
        expect(socket.sent).toEqual([steer]);
      }),
    ),
  );

  it.effect("queues a message for a Runner that can't take a steer", () =>
    withObject(freshDatabase(), (engine, runner) =>
      Effect.gen(function* () {
        const { socket } = yield* runningTurn(engine, runner, false);

        yield* send(engine, 2, "Also check the tests");
        const { projection } = yield* snapshot(engine);
        expect(projection.runs.map((run) => run.status)).toEqual(["running", "queued"]);
        expect(socket.sent.filter((message) => message.type === "steer")).toEqual([]);
      }),
    ),
  );

  it.effect("removes a queued message so it never runs", () =>
    withObject(freshDatabase(), (engine, runner) =>
      Effect.gen(function* () {
        const { host, socket, turn, report } = yield* runningTurn(engine, runner, false);
        yield* send(engine, 2, "First follow-up");
        yield* send(engine, 3, "Second follow-up");
        const queued = (yield* snapshot(engine)).projection.runs.filter(
          (run) => run.status === "queued",
        );
        const [first, second] = queued;
        if (first === undefined || second === undefined) throw new Error("expected two queued");

        yield* engine.dispatch(
          owner,
          command("queued-run.cancel", { runId: first.id }) as never,
          personal,
        );
        const afterCancel = (yield* snapshot(engine)).projection.runs;
        expect(afterCancel.map((run) => [run.status, run.queuePosition])).toEqual([
          ["running", null],
          ["cancelled", null],
          ["queued", 1],
        ]);

        // The turn ends: the message left in the queue runs, the removed one never does.
        yield* say(host, socket, {
          type: "batch",
          sequence: 2,
          items: [report.full, report.terminal],
        });
        const ended = (yield* snapshot(engine)).projection.runs;
        expect(ended.map((run) => run.status)).toEqual(["completed", "cancelled", "starting"]);
        const start = socket.sent.find((message) => message.type === "turn.start");
        expect(start?.type === "turn.start" ? start.turn.runId : null).toBe(second.id);
        expect(turn.runId).not.toBe(second.id);
      }),
    ),
  );

  it.effect("steers a queued message into the running turn", () =>
    withObject(freshDatabase(), (engine, runner) =>
      Effect.gen(function* () {
        const { host, socket, turn } = yield* runningTurn(engine, runner, true);
        yield* engine.dispatch(
          owner,
          {
            type: "message.dispatch",
            commandId: CommandId.make("queue-2"),
            createdBy: "user",
            creationSource: "web",
            threadId,
            messageId: MessageId.make("message-2"),
            text: "Later",
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
          },
          personal,
        );
        const queued = (yield* snapshot(engine)).projection.runs[1];
        if (queued?.status !== "queued") throw new Error("expected a queued run");

        yield* dispatched(
          host,
          engine.dispatch(
            owner,
            command("queued-message.promote-to-steer", {
              queuedRunId: queued.id,
              targetRunId: turn.runId,
            }) as never,
            personal,
          ),
        );
        const { projection } = yield* snapshot(engine);
        expect(projection.runs.map((run) => run.status)).toEqual(["running", "cancelled"]);
        expect(projection.messages.find((message) => message.id === "message-2")?.runId).toBe(
          turn.runId,
        );
        expect(socket.sent).toMatchObject([
          { type: "steer", runId: turn.runId, message: { messageId: "message-2", text: "Later" } },
        ]);
      }),
    ),
  );

  it.effect("refuses to remove a message that is no longer queued", () =>
    withObject(freshDatabase(), (engine, runner) =>
      Effect.gen(function* () {
        const { turn } = yield* runningTurn(engine, runner, false);
        const result = yield* Effect.flip(
          engine.dispatch(
            owner,
            command("queued-run.cancel", { runId: turn.runId as RunId }) as never,
            personal,
          ),
        );
        expect(result).toMatchObject({ _tag: "ThreadCommandRejectedError" });
      }),
    ),
  );

  it.effect("queues a message once the harness turn ended and only its files are saving", () =>
    withObject(freshDatabase(), (engine, runner) =>
      Effect.gen(function* () {
        const { host, socket, providerTurn } = yield* runningTurn(engine, runner, true);
        const ended = {
          ...providerTurn,
          event: {
            ...providerTurn.event,
            providerTurn: { ...providerTurn.event.providerTurn, status: "completed" },
          },
        };
        yield* say(host, socket, { type: "batch", sequence: 2, items: [ended] });

        yield* dispatched(host, send(engine, 2, "One more thing"));
        const { projection } = yield* snapshot(engine);
        expect(projection.runs.map((run) => run.status)).toEqual(["running", "queued"]);
        expect(socket.sent.filter((message) => message.type === "steer")).toEqual([]);
      }),
    ),
  );

  it.effect("hands over a queued message steered in after a newer one", () =>
    withObject(freshDatabase(), (engine, runner) =>
      Effect.gen(function* () {
        const { host, socket, turn } = yield* runningTurn(engine, runner, true);
        yield* dispatched(
          host,
          engine.dispatch(
            owner,
            {
              type: "message.dispatch",
              commandId: CommandId.make("queue-2"),
              createdBy: "user",
              creationSource: "web",
              threadId,
              messageId: MessageId.make("message-2"),
              text: "Queued first",
              attachments: [],
              dispatchMode: { type: "queue_after_active" },
            },
            personal,
          ),
        );
        yield* dispatched(host, send(engine, 3, "Steered second"));
        const queued = (yield* snapshot(engine)).projection.runs[1];
        if (queued?.status !== "queued") throw new Error("expected a queued run");
        yield* dispatched(
          host,
          engine.dispatch(
            owner,
            command("queued-message.promote-to-steer", {
              queuedRunId: queued.id,
              targetRunId: turn.runId,
            }) as never,
            personal,
          ),
        );

        expect(
          socket.sent.flatMap((message) =>
            message.type === "steer" ? [message.message.messageId] : [],
          ),
        ).toEqual(["message-3", "message-2"]);
      }),
    ),
  );

  // #653: a resume that fails on the machine must not start a session with no conversation.
  it.effect("hands a turn that resumes its session the conversation for a new one", () =>
    withObject(freshDatabase(), (engine, runner, context) =>
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
        yield* saveSession(context, "claude-session-1");
        yield* runner.ended(first.generation, "test");
        yield* send(engine, 2, "Again");

        const plan = yield* runner.reconcile;
        if (plan.ensure === null) throw new Error("expected a machine request");
        yield* runner.ensured(plan.ensure.generation);
        const sockets: Array<WebSocket> = [];
        const host = yield* hostFor(runner, sockets);
        const socket = fakeSocket();
        sockets.push(socket.socket);
        yield* say(host, socket, {
          ...hello(plan.ensure.generation, plan.ensure.token),
          takenRunIds: [],
        });
        const start = socket.sent.find((message) => message.type === "turn.start");
        if (start?.type !== "turn.start") throw new Error("expected the turn");
        expect(start.turn).toMatchObject({
          providerTurnOrdinal: 2,
          message: { text: "Again" },
          providerThread: { nativeThreadRef: { nativeId: "claude-session-1" } },
        });
        expect(start.turn.freshSessionText).toContain("User:\nHi\n\nAssistant:\nHello!\n\n");
        expect(start.turn.freshSessionText?.endsWith("User message:\nAgain")).toBe(true);
      }),
    ),
  );

  it.effect("hands a turn on a new session no second copy of the conversation", () =>
    withObject(freshDatabase(), (engine, runner) =>
      Effect.gen(function* () {
        const { turn } = yield* runningTurn(engine, runner, false);
        expect(turn.freshSessionText).toBeUndefined();
      }),
    ),
  );
});
