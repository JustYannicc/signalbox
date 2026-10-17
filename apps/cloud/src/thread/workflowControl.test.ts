import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  NodeId,
  OrchestrationV2Subagent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import { SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import { claude } from "./runner/runnerTestKit.ts";
import { runEvent } from "./threadEvents.ts";

import { ThreadStore } from "./ThreadStore.ts";
import {
  coordinatorId,
  siblingId,
  childId,
  scriptPath,
  workflowFixture,
} from "./workflowTestKit.ts";
import { recordedEvents } from "./runner/runnerEvents.ts";
import {
  freshDatabase,
  withObject,
  launch,
  owner,
  threadId,
  hello,
  turnReport,
  liveTurn,
  fakeSocket,
  hostFor,
} from "./runner/runnerTestKit.ts";
import { pushRunnerWork, onRunnerMessage } from "./runner/runnerSockets.ts";

const encodeSubagent = Schema.encodeSync(Schema.toCodecJson(OrchestrationV2Subagent));

const stranger = { ...owner, userId: "user_2" };
const get = { threadId, subagentId: coordinatorId, scriptPath };
const stop = { threadId, subagentId: coordinatorId };

const seed = (engine: Parameters<Parameters<typeof withObject>[1]>[0]) =>
  engine.apply((projection, ctx) => {
    if (projection === null) throw new Error("No thread");
    const fixture = workflowFixture(projection, ctx);
    return Effect.succeed({ events: fixture.events, scripts: fixture.scripts, result: fixture });
  });

describe("thread workflow control", () => {
  it.effect(
    "reads a retained coordinator revision after eviction without a machine, and rejects ambiguous paths",
    () => {
      const file = freshDatabase();
      return Effect.gen(function* () {
        yield* withObject(file, (engine) =>
          Effect.gen(function* () {
            yield* launch(engine);
            yield* seed(engine);
            expect((yield* engine.getWorkflowScript(owner, get)).contents).toContain(
              "exact workflow-one",
            );
            const ambiguous = yield* engine
              .getWorkflowScript(owner, { threadId, scriptPath })
              .pipe(Effect.result);
            expect(ambiguous._tag).toBe("Failure");
          }),
        );
        yield* withObject(file, (engine) =>
          Effect.gen(function* () {
            expect(yield* engine.getWorkflowScript(owner, get)).toMatchObject({
              revision: "revision:workflow-one",
              truncated: false,
            });
            expect(
              (yield* engine.getWorkflowScript(owner, { ...get, subagentId: siblingId })).contents,
            ).toContain("exact workflow-two");
          }),
        );
      });
    },
  );

  it.effect("checks owner and current context before reading scripts or recording a stop", () =>
    withObject(freshDatabase(), (engine) =>
      Effect.gen(function* () {
        yield* launch(engine);
        yield* seed(engine);
        const before = yield* engine.snapshot(owner);
        for (const actor of [stranger]) {
          const read = yield* engine.getWorkflowScript(actor, get).pipe(Effect.result);
          const stopped = yield* engine.stopWorkflow(actor, stop).pipe(Effect.result);
          expect(read).toMatchObject({ _tag: "Failure", failure: { _tag: "ThreadNotFoundError" } });
          expect(stopped).toMatchObject({
            _tag: "Failure",
            failure: { _tag: "ThreadNotFoundError" },
          });
        }
        expect(yield* engine.snapshot(owner)).toEqual(before);
        expect(
          yield* engine
            .getWorkflowScript(owner, { ...get, scriptPath: "/arbitrary.js" })
            .pipe(Effect.result),
        ).toMatchObject({ _tag: "Failure" });
      }),
    ),
  );

  it.effect("refuses the owner after they leave the thread's organisation", () =>
    withObject(freshDatabase(), (engine) =>
      Effect.gen(function* () {
        const contextId = SignalboxContextId.make("org_work");
        const member = { ...owner, contextIds: [contextId] };
        yield* engine.launch(
          member,
          {
            commandId: CommandId.make("launch-org"),
            threadId,
            projectId: ProjectId.make("scratch"),
            title: "Org workflow",
            modelSelection: claude,
            runtimeMode: "full-access",
            interactionMode: "default",
            workspaceStrategy: { type: "root" },
            initialMessage: { messageId: MessageId.make("first"), text: "Review", attachments: [] },
          },
          {
            place: { contextId, driveId: "my/org_work/user_1" },
            pools: { top: "personal", projects: {} },
          },
        );
        yield* seed(engine);
        expect((yield* engine.getWorkflowScript(member, get)).revision).toBe(
          "revision:workflow-one",
        );
        expect(yield* engine.getWorkflowScript(owner, get).pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "ThreadNotFoundError" },
        });
        expect(yield* engine.stopWorkflow(owner, stop).pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "ThreadNotFoundError" },
        });
      }),
    ),
  );

  it.effect(
    "stops only one workflow and its descendants, persists it, refreshes the shell, and ignores repeat stops",
    () => {
      const file = freshDatabase();
      return Effect.gen(function* () {
        yield* withObject(file, (engine) =>
          Effect.gen(function* () {
            yield* launch(engine);
            yield* seed(engine);
            yield* engine.apply((projection, ctx) =>
              Effect.succeed({
                events: [
                  runEvent(ctx, "run.updated", {
                    ...projection!.runs[0]!,
                    status: "completed",
                    completedAt: ctx.now,
                  }),
                ],
                result: undefined,
              }),
            );
            const before = yield* engine.snapshot(owner);
            const oldSummary = yield* engine.pendingSummary;
            yield* engine.stopWorkflow(owner, stop);
            const after = yield* engine.snapshot(owner);
            expect(after.projection.runs).toEqual(before.projection.runs);
            expect(after.projection.subagents.find((task) => task.id === siblingId)).toEqual(
              before.projection.subagents.find((task) => task.id === siblingId),
            );
            for (const id of [coordinatorId, childId]) {
              expect(after.projection.subagents.find((task) => task.id === id)?.status).toBe(
                "cancelled",
              );
              expect(after.projection.nodes.find((node) => node.id === id)?.status).toBe(
                "cancelled",
              );
            }
            expect(
              after.projection.subagents.find((task) => task.id === coordinatorId)?.workflow,
            ).toMatchObject({ stop: { status: "stopped" }, agents: [{ state: "failed" }] });
            expect((yield* engine.pendingSummary)?.summary.revision).toBeGreaterThan(
              oldSummary!.summary.revision,
            );
            yield* engine.stopWorkflow(owner, stop);
            expect(yield* engine.snapshot(owner)).toEqual(after);
            const late = before.projection.subagents.find((task) => task.id === coordinatorId)!;
            yield* engine.apply((projection, ctx) => {
              const events = recordedEvents(
                projection!,
                {
                  kind: "provider",
                  runId: late.runId!,
                  event: {
                    type: "subagent.updated",
                    subagent: encodeSubagent(late),
                  },
                },
                late.runId!,
                ctx,
              );
              if (events === "undecodable") throw new Error("Invalid fixture");
              return Effect.succeed({ events, result: undefined });
            });
            expect(yield* engine.snapshot(owner)).toEqual(after);
          }),
        );
        yield* withObject(file, (engine) =>
          Effect.gen(function* () {
            const snapshot = yield* engine.snapshot(owner);
            expect(
              snapshot.projection.subagents.find((task) => task.id === coordinatorId)?.status,
            ).toBe("cancelled");
            yield* engine.stopWorkflow(owner, stop);
            expect(yield* engine.snapshot(owner)).toEqual(snapshot);
          }),
        );
      });
    },
  );

  it.effect("fences stop delivery and acknowledgments, leaving the parent and sibling live", () =>
    withObject(freshDatabase(), (engine, runner) =>
      Effect.gen(function* () {
        yield* launch(engine);
        const plan = yield* runner.reconcile;
        if (plan.ensure === null) throw new Error("No lease");
        const generation = plan.ensure.generation;
        yield* runner.ensured(generation);
        const socket = fakeSocket();
        const stale = fakeSocket();
        stale.socket.serializeAttachment({
          generation: generation + 1,
          connection: 1,
          sentRunId: null,
        });
        const host = yield* hostFor(runner, [socket.socket, stale.socket]);
        yield* Effect.promise(() =>
          onRunnerMessage(
            host,
            socket.socket,
            JSON.stringify({ ...hello(generation, plan.ensure!.token), workflowStops: true }),
          ),
        );
        const start = socket.sent.find((message) => message.type === "turn.start");
        if (start?.type !== "turn.start") throw new Error("No turn");
        const report = turnReport(
          start.turn.runId,
          start.turn.runOrdinal,
          start.turn.providerThread,
        );
        yield* runner.batch({ generation, sequence: 1, items: [report.started] });
        yield* seed(engine);
        yield* engine.stopWorkflow(owner, stop);
        const pending = yield* engine.snapshot(owner);
        expect(pending.projection.subagents.find((task) => task.id === coordinatorId)?.status).toBe(
          "running",
        );
        yield* Effect.promise(() => pushRunnerWork(host));
        yield* Effect.promise(() => pushRunnerWork(host));
        const requests = socket.sent.filter((message) => message.type === "workflow.stop");
        expect(requests).toHaveLength(1);
        expect(stale.sent).toHaveLength(0);
        const request = requests[0]!;
        if (request.type !== "workflow.stop") throw new Error("No request");
        const result = { kind: "workflow.stopped" as const, ...request, ok: true };
        expect(
          yield* runner.batch({ generation: generation + 1, sequence: 2, items: [result] }),
        ).toEqual({ _tag: "stale" });
        yield* runner.batch({
          generation,
          sequence: 2,
          items: [{ ...result, generation: generation + 1 }],
        });
        expect(
          (yield* engine.snapshot(owner)).projection.subagents.find(
            (task) => task.id === coordinatorId,
          )?.status,
        ).toBe("running");
        yield* runner.batch({ generation, sequence: 3, items: [result] });
        const done = yield* engine.snapshot(owner);
        expect(done.projection.subagents.find((task) => task.id === coordinatorId)?.status).toBe(
          "cancelled",
        );
        expect(done.projection.subagents.find((task) => task.id === siblingId)?.status).toBe(
          "running",
        );
        expect(done.projection.runs).toEqual(pending.projection.runs);
        expect(socket.sent.filter((message) => message.type === "interrupt")).toEqual([]);
        yield* runner.batch({ generation, sequence: 4, items: [result] });
        expect(yield* engine.snapshot(owner)).toEqual(done);
      }),
    ),
  );

  it.effect(
    "rejects non-workflows and refuses an old Runner rather than interrupting its parent",
    () =>
      withObject(freshDatabase(), (engine, runner) =>
        Effect.gen(function* () {
          yield* launch(engine);
          yield* seed(engine);
          const plan = yield* runner.reconcile;
          if (plan.ensure === null) throw new Error("No machine");
          yield* runner.hello(hello(plan.ensure.generation, plan.ensure.token));
          const before = yield* engine.snapshot(owner);
          for (const subagentId of [childId, NodeId.make("missing"), coordinatorId]) {
            expect(
              yield* engine.stopWorkflow(owner, { threadId, subagentId }).pipe(Effect.result),
            ).toMatchObject({ _tag: "Failure" });
          }
          expect(yield* engine.snapshot(owner)).toEqual(before);
        }),
      ),
  );

  it.effect(
    "retains only the attached revision, atomically with a generation-fenced Runner batch",
    () =>
      withObject(freshDatabase(), (engine, runner, context) =>
        Effect.gen(function* () {
          yield* launch(engine);
          const plan = yield* runner.reconcile;
          if (plan.ensure === null) throw new Error("No machine");
          const generation = plan.ensure.generation;
          yield* runner.hello(hello(generation, plan.ensure.token));
          const turn = yield* liveTurn(runner);
          const fixture = yield* engine.apply((projection, ctx) => {
            const data = workflowFixture(projection!, ctx);
            return Effect.succeed({ events: data.events, result: data });
          });
          const script = fixture.scripts[0]!;
          const item = {
            kind: "provider" as const,
            runId: script.runId,
            event: { type: "workflow.script", ...script },
          };
          yield* runner.batch({ generation: generation + 1, sequence: 1, items: [item] });
          expect(yield* engine.getWorkflowScript(owner, get).pipe(Effect.result)).toMatchObject({
            _tag: "Failure",
          });
          yield* runner.batch({
            generation,
            sequence: 1,
            items: [
              { ...item, event: { ...item.event, subagentId: childId } },
              { ...item, event: { ...item.event, revision: "other" } },
            ],
          });
          expect(yield* engine.getWorkflowScript(owner, get).pipe(Effect.result)).toMatchObject({
            _tag: "Failure",
          });
          yield* runner.batch({ generation, sequence: 2, items: [item] });
          expect((yield* engine.getWorkflowScript(owner, get)).contents).toBe(script.contents);
          yield* runner.batch({
            generation,
            sequence: 3,
            items: [{ ...item, event: { ...item.event, contents: "replacement" } }],
          });
          expect((yield* engine.getWorkflowScript(owner, get)).contents).toBe(script.contents);
          expect(
            yield* Context.get(context, ThreadStore).workflowScript(childId, script.revision),
          ).toBeNull();
          expect(turn.runId).toBe(script.runId);
        }),
      ),
  );
});
