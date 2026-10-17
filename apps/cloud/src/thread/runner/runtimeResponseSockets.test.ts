import {
  CommandId,
  NodeId,
  OrchestrationV2ExecutionNode,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2TurnItem,
  ProviderTurnId,
  RuntimeRequestId,
  TurnItemId,
} from "@t3tools/contracts";
import type { RunnerItem, ThreadMessage } from "@signalbox/runner-protocol/RunnerProtocol";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  fakeSocket,
  freshDatabase,
  hello,
  hostFor,
  launch,
  owner,
  personal,
  snapshot,
  threadId,
  turnReport,
  withObject,
} from "./runnerTestKit.ts";
import type { ThreadRunner } from "./ThreadRunner.ts";
import { onRunnerMessage, pushRunnerWork, type RunnerSocketHost } from "./runnerSockets.ts";

const encodeNode = Schema.encodeSync(Schema.toCodecJson(OrchestrationV2ExecutionNode));
const encodeRuntimeRequest = Schema.encodeSync(Schema.toCodecJson(OrchestrationV2RuntimeRequest));
const encodeTurnItem = Schema.encodeSync(Schema.toCodecJson(OrchestrationV2TurnItem));

const say = (host: RunnerSocketHost, socket: ReturnType<typeof fakeSocket>, message: object) =>
  Effect.promise(() => onRunnerMessage(host, socket.socket, JSON.stringify(message)));

const responseFrames = (socket: ReturnType<typeof fakeSocket>) =>
  socket.sent.filter(
    (message): message is Extract<ThreadMessage, { type: "runtime-request.respond" }> =>
      message.type === "runtime-request.respond",
  );

const runningSocket = (
  engine: Parameters<typeof launch>[0],
  runner: ThreadRunner["Service"],
  acceptsRuntimeResponses: boolean,
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
      runtimeResponses: acceptsRuntimeResponses ? true : undefined,
    });

    const start = socket.sent.find((message) => message.type === "turn.start");
    if (start?.type !== "turn.start") throw new Error("expected the turn start");
    const { turn } = start;
    const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
    const providerTurnId = ProviderTurnId.make(`native-turn:${turn.runId}`);
    const providerTurn: RunnerItem = {
      kind: "provider",
      runId: turn.runId,
      event: {
        type: "provider_turn.updated",
        driver: report.started.providerSession.driver,
        providerTurn: {
          id: providerTurnId,
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
      items: [report.started, providerTurn],
    });
    socket.sent.length = 0;

    return {
      host,
      sockets,
      socket,
      turn,
      report,
      providerTurnId,
      generation: plan.ensure.generation,
      token: plan.ensure.token,
    };
  });

const pendingQuestion = (
  engine: Parameters<typeof launch>[0],
  runner: ThreadRunner["Service"],
  acceptsRuntimeResponses: boolean,
) =>
  Effect.gen(function* () {
    const connected = yield* runningSocket(engine, runner, acceptsRuntimeResponses);
    const { projection } = yield* snapshot(engine);
    const root = projection.nodes.find((node) => node.id === connected.turn.rootNodeId);
    if (root === undefined) throw new Error("expected the run's root node");
    const requestId = RuntimeRequestId.make(`question:${connected.turn.runId}`);
    const node: typeof root = {
      ...root,
      id: NodeId.make(`question-node:${connected.turn.runId}`),
      parentNodeId: root.id,
      kind: "user_input_request",
      status: "waiting",
      providerTurnId: connected.providerTurnId,
      runtimeRequestId: requestId,
      startedAt: projection.updatedAt,
      completedAt: null,
    };
    const turnItem: OrchestrationV2TurnItem = {
      id: TurnItemId.make(`question-item:${connected.turn.runId}`),
      threadId,
      runId: connected.turn.runId,
      nodeId: node.id,
      providerThreadId: connected.turn.providerThread.id,
      providerTurnId: connected.providerTurnId,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1_000_001,
      status: "waiting",
      title: null,
      startedAt: projection.updatedAt,
      completedAt: null,
      updatedAt: projection.updatedAt,
      type: "user_input_request",
      requestId,
      questions: [{ id: "choice", header: "Colour", question: "Which colour?", options: [] }],
    };
    const request: OrchestrationV2RuntimeRequest = {
      id: requestId,
      nodeId: node.id,
      providerTurnId: connected.providerTurnId,
      nativeRequestRef: null,
      kind: "user_input",
      status: "pending",
      responseCapability: {
        type: "live",
        providerSessionId: connected.report.started.providerSession.id,
      },
      createdAt: projection.updatedAt,
      resolvedAt: null,
    };
    yield* say(connected.host, connected.socket, {
      type: "batch",
      sequence: 2,
      items: [
        {
          kind: "provider",
          runId: connected.turn.runId,
          event: {
            type: "node.updated",
            driver: connected.report.started.providerSession.driver,
            node: encodeNode(node),
          },
        },
        {
          kind: "provider",
          runId: connected.turn.runId,
          event: {
            type: "turn_item.updated",
            driver: connected.report.started.providerSession.driver,
            turnItem: encodeTurnItem(turnItem),
          },
        },
        {
          kind: "provider",
          runId: connected.turn.runId,
          event: {
            type: "runtime_request.updated",
            driver: connected.report.started.providerSession.driver,
            runtimeRequest: encodeRuntimeRequest(request),
          },
        },
      ],
    });
    return { ...connected, requestId };
  });

const answer = (requestId: RuntimeRequestId, commandId: string) => ({
  type: "runtime-request.respond" as const,
  commandId: CommandId.make(commandId),
  threadId,
  requestId,
  answers: { choice: "Blue" },
});

describe("runtime response sockets", () => {
  it.effect("sends committed responses once per connection and replays them after reconnect", () =>
    withObject(freshDatabase(), (engine, runner) =>
      Effect.gen(function* () {
        const connected = yield* pendingQuestion(engine, runner, true);
        yield* engine.dispatch(owner, answer(connected.requestId, "answer-1"), personal);
        const committed = yield* snapshot(engine);
        expect(committed.projection.runtimeRequests).toContainEqual(
          expect.objectContaining({
            id: connected.requestId,
            status: "resolved",
            answers: { choice: "Blue" },
          }),
        );

        yield* Effect.promise(() => pushRunnerWork(connected.host));
        yield* Effect.promise(() => pushRunnerWork(connected.host));

        const expected = {
          type: "runtime-request.respond",
          runId: connected.turn.runId,
          attemptId: connected.turn.attemptId,
          providerSessionId: connected.report.started.providerSession.id,
          requestId: connected.requestId,
          answers: { choice: "Blue" },
        };
        expect(responseFrames(connected.socket)).toEqual([expected]);

        connected.sockets.splice(connected.sockets.indexOf(connected.socket.socket), 1);
        const reconnected = fakeSocket();
        connected.sockets.push(reconnected.socket);
        yield* say(connected.host, reconnected, {
          ...hello(connected.generation, connected.token),
          lastAckedSequence: 2,
          takenRunIds: [connected.turn.runId],
          runtimeResponses: true,
        });
        yield* Effect.promise(() => pushRunnerWork(connected.host));

        expect(responseFrames(reconnected)).toEqual([expected]);
      }),
    ),
  );

  it.effect.each(["answer", "dismiss"] as const)(
    "keeps a legacy question pending when %s races its machine update",
    (action) =>
      withObject(freshDatabase(), (engine, runner) =>
        Effect.gen(function* () {
          const connected = yield* pendingQuestion(engine, runner, false);
          const command =
            action === "answer"
              ? answer(connected.requestId, "answer-old")
              : {
                  type: "thread.user-input.dismiss" as const,
                  commandId: CommandId.make("dismiss-old"),
                  threadId,
                  requestId: connected.requestId,
                };
          expect(yield* Effect.result(engine.dispatch(owner, command, personal))).toMatchObject({
            _tag: "Failure",
            failure: { reason: expect.stringContaining("updating") },
          });
          expect((yield* snapshot(engine)).projection.runtimeRequests).toContainEqual(
            expect.objectContaining({ id: connected.requestId, status: "pending" }),
          );
          expect((yield* runner.work).needsUpkeep).toBe(true);
          expect(responseFrames(connected.socket)).toEqual([]);

          // A temporary refusal keeps no receipt: the same command can work once supported.
          connected.sockets.splice(connected.sockets.indexOf(connected.socket.socket), 1);
          const modern = fakeSocket();
          connected.sockets.push(modern.socket);
          yield* say(connected.host, modern, {
            ...hello(connected.generation, connected.token),
            lastAckedSequence: 2,
            takenRunIds: [connected.turn.runId],
          });
          yield* engine.dispatch(owner, command, personal);
          yield* Effect.promise(() => pushRunnerWork(connected.host));
          expect(responseFrames(modern)).toMatchObject([
            { requestId: connected.requestId, runId: connected.turn.runId },
          ]);
        }),
      ),
  );

  it.effect("rejects late answers after a stop and sends no response frame", () =>
    withObject(freshDatabase(), (engine, runner) =>
      Effect.gen(function* () {
        const connected = yield* pendingQuestion(engine, runner, true);
        yield* engine.dispatch(
          owner,
          {
            type: "run.interrupt",
            commandId: CommandId.make("stop-before-answer"),
            threadId,
            runId: connected.turn.runId,
          },
          personal,
        );
        expect(
          yield* Effect.result(
            engine.dispatch(owner, answer(connected.requestId, "late-answer"), personal),
          ),
        ).toMatchObject({ _tag: "Failure" });
        yield* Effect.promise(() => pushRunnerWork(connected.host));

        expect(responseFrames(connected.socket)).toEqual([]);
        expect(connected.socket.sent).toContainEqual({
          type: "interrupt",
          runId: connected.turn.runId,
        });
      }),
    ),
  );

  it.effect("fences a committed answer if its run stops before socket delivery", () =>
    withObject(freshDatabase(), (engine, runner) =>
      Effect.gen(function* () {
        const connected = yield* pendingQuestion(engine, runner, true);
        yield* engine.dispatch(owner, answer(connected.requestId, "answer-then-stop"), personal);
        yield* engine.dispatch(
          owner,
          {
            type: "run.interrupt",
            commandId: CommandId.make("stop-before-delivery"),
            threadId,
            runId: connected.turn.runId,
          },
          personal,
        );
        expect((yield* runner.work).runtimeResponses).toEqual([]);
        yield* Effect.promise(() => pushRunnerWork(connected.host));

        expect(responseFrames(connected.socket)).toEqual([]);
        expect(connected.socket.sent).toContainEqual({
          type: "interrupt",
          runId: connected.turn.runId,
        });
      }),
    ),
  );
});
