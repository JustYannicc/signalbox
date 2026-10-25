import { describe, expect, it } from "@effect/vitest";
import { NodeId } from "@t3tools/contracts";
import { RUNNER_PROTOCOL_VERSION } from "@signalbox/runner-protocol/RunnerProtocol";
import * as Effect from "effect/Effect";

import {
  fakeSocket,
  freshDatabase,
  hello,
  hostFor,
  launch,
  onRunnerMessage,
  owner,
  pushRunnerWork,
  threadId,
  turnReport,
  withObject,
} from "./runnerTesting.ts";
import { workflowFixture } from "./workflowTestKit.ts";
import { workflowEvent } from "./workflowControl.ts";

const setup = (
  engine: Parameters<Parameters<typeof withObject>[1]>[0],
  runner: Parameters<Parameters<typeof withObject>[1]>[1],
  protocolVersion = 6,
) =>
  Effect.gen(function* () {
    yield* launch(engine);
    const plan = yield* runner.reconcile;
    if (plan.ensure === null) throw new Error("No machine");
    const { generation, token } = plan.ensure;
    const socket = fakeSocket();
    const serialize = socket.socket.serializeAttachment.bind(socket.socket);
    socket.socket.serializeAttachment = (value: unknown) => {
      expect(new TextEncoder().encode(JSON.stringify(value)).byteLength).toBeLessThanOrEqual(2048);
      serialize(value);
    };
    const sockets = [socket.socket];
    const host = yield* hostFor(runner, sockets);
    yield* Effect.promise(() =>
      onRunnerMessage(
        host,
        socket.socket,
        JSON.stringify({ ...hello(generation, token), protocolVersion, workflowStops: true }),
      ),
    );
    const start = socket.sent.find((message) => message.type === "turn.start");
    if (start?.type !== "turn.start") throw new Error("No turn");
    const { turn } = start;
    let sequence = 0;
    if (turn.preparationGeneration !== undefined) {
      yield* Effect.promise(() =>
        onRunnerMessage(
          host,
          socket.socket,
          JSON.stringify({
            type: "batch",
            sequence: ++sequence,
            items: [
              {
                kind: "preparation.ready",
                runId: turn.runId,
                preparationGeneration: turn.preparationGeneration,
              },
            ],
          }),
        ),
      );
      expect(socket.sent).toContainEqual({
        type: "preparation.handoff",
        runId: turn.runId,
        preparationGeneration: turn.preparationGeneration,
      });
    }
    yield* runner.batch({
      generation,
      sequence: ++sequence,
      items: [
        {
          ...turnReport(turn.runId, turn.runOrdinal, turn.providerThread).started,
          preparationGeneration: turn.preparationGeneration,
        },
      ],
    });
    const tasks = yield* engine.apply((projection, ctx) => {
      const template = workflowFixture(projection!, ctx).tasks[0]!;
      const tasks = Array.from({ length: 49 }, (_, index) => {
        const id = NodeId.make(
          `workflow-coordinator-${index}-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`,
        );
        return {
          ...template,
          id,
          nativeTaskRef: { ...template.nativeTaskRef!, nativeId: `native:${id}` },
        };
      });
      return Effect.succeed({
        events: tasks.map((task) => workflowEvent(ctx, task)),
        result: tasks,
      });
    });
    const stops = () => socket.sent.filter((message) => message.type === "workflow.stop");
    const push = Effect.promise(() => pushRunnerWork(host));
    return {
      host,
      socket,
      sockets,
      generation,
      token,
      turn,
      tasks,
      stops,
      push,
      lastAckedSequence: sequence,
    };
  });

describe("workflow stop delivery attachments", () => {
  it.effect("stays bounded through completed stops and retries on one connection", () =>
    withObject(freshDatabase(), (engine, runner) =>
      Effect.gen(function* () {
        const { tasks, socket, generation, stops, push } = yield* setup(engine, runner);
        let sequence = 2;
        for (const task of tasks.slice(0, 32)) {
          yield* engine.stopWorkflow(owner, { threadId, subagentId: task.id });
          yield* push;
          const first = stops().at(-1)!;
          expect(first.subagentId).toBe(task.id);
          const count = stops().length;
          yield* push;
          expect(stops()).toHaveLength(count);
          yield* runner.batch({
            generation,
            sequence: sequence++,
            items: [{ ...first, kind: "workflow.stopped", ok: false }],
          });
          yield* push;
          yield* engine.stopWorkflow(owner, { threadId, subagentId: task.id });
          yield* push;
          const retry = stops().at(-1)!;
          expect(retry).toMatchObject({ subagentId: task.id, attempt: 2 });
          yield* runner.batch({
            generation,
            sequence: sequence++,
            items: [{ ...retry, kind: "workflow.stopped", ok: true }],
          });
          yield* push;
        }
        expect(stops()).toHaveLength(64);
        expect(
          new TextEncoder().encode(JSON.stringify(socket.socket.deserializeAttachment()))
            .byteLength,
        ).toBeLessThan(512);
      }),
    ),
  );

  it.effect.each([6, RUNNER_PROTOCOL_VERSION])(
    "bounds pending stops and replays on reconnect after protocol %i handoff",
    (protocolVersion) =>
      withObject(freshDatabase(), (engine, runner) =>
        Effect.gen(function* () {
          const {
            host,
            socket,
            sockets,
            generation,
            token,
            turn,
            tasks,
            stops,
            push,
            lastAckedSequence,
          } = yield* setup(engine, runner, protocolVersion);
          for (const task of tasks.slice(0, 48)) {
            yield* engine.stopWorkflow(owner, { threadId, subagentId: task.id });
          }
          socket.socket.serializeAttachment({
            generation,
            connection: (yield* runner.work).connection,
            sentRunId: turn.runId,
            sentWorkflowStops: ["legacy-stop-identity"],
          });
          yield* push;
          expect(stops()).toHaveLength(48);
          expect(typeof socket.socket.deserializeAttachment().sentWorkflowStops).toBe("string");
          yield* push;
          expect(stops()).toHaveLength(48);
          const first = stops()[0]!;
          yield* runner.batch({
            generation,
            sequence: lastAckedSequence + 1,
            items: [{ ...first, kind: "workflow.stopped", ok: true }],
          });
          yield* engine.stopWorkflow(owner, { threadId, subagentId: tasks[48]!.id });
          yield* push;
          const replaced = stops().slice(48);
          expect(replaced).toHaveLength(48);
          expect(replaced.some((stop) => stop.subagentId === tasks[48]!.id)).toBe(true);
          expect(replaced.some((stop) => stop.subagentId === first.subagentId)).toBe(false);
          yield* push;
          expect(stops()).toHaveLength(96);
          const again = fakeSocket();
          sockets.push(again.socket);
          yield* Effect.promise(() =>
            onRunnerMessage(
              host,
              again.socket,
              JSON.stringify({
                ...hello(generation, token),
                protocolVersion,
                lastAckedSequence: lastAckedSequence + 1,
                takenRunIds: [turn.runId],
                workflowStops: true,
              }),
            ),
          );
          expect(again.sent.filter((message) => message.type === "workflow.stop")).toHaveLength(48);
          yield* push;
          expect(again.sent.filter((message) => message.type === "workflow.stop")).toHaveLength(48);
          expect(stops()).toHaveLength(96);
          expect(socket.sent.filter((message) => message.type === "interrupt")).toEqual([]);
        }),
      ),
  );
});
