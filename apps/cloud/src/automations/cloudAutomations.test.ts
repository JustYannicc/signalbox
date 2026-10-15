import {
  AUTOMATION_WS_METHODS,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  CommandId,
  EnvironmentId,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  ThreadId,
} from "@t3tools/contracts";
import * as WorkflowEngine from "@signalbox/automations/WorkflowEngine";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";
import * as TestClock from "effect/testing/TestClock";

// The machine compiles saves (oxc can't run in workerd); tests compile the same way it does.
import { compileWorkflow } from "../../../server/src/workflows/compiler/compileWorkflow.ts";
import * as Environment from "../environment.ts";
import { makeMemoryCloud } from "../testing.ts";
import { scriptedModelSelection } from "../thread/scriptedProvider.ts";
import * as CloudRpc from "../user/rpc.ts";
import { CloudAutomations } from "./CloudAutomations.ts";

/**
 * #434: a user's automations run on their own object, with no client
 * connected. Thread events arrive from the thread objects, timers fire on
 * the object's alarm, and asks wait for the person.
 */

const identity = { environmentId: EnvironmentId.make("cloud-test"), label: "Cloud" };
const userId = "user_1";

const setup = Effect.gen(function* () {
  const cloud = makeMemoryCloud();
  yield* cloud.userDirectory.forUser(userId).recordSignIn({ id: userId, email: "a@b.c" });
  const rpc = yield* RpcTest.makeClient(CloudRpc.CloudRpcGroup).pipe(
    Effect.provide(
      Layer.mergeAll(
        CloudRpc.layerHandlers({ identity, userId, sid: "test-session" }),
        CloudRpc.layerScopeAuthorization([
          AuthOrchestrationReadScope,
          AuthOrchestrationOperateScope,
        ]),
      ).pipe(Layer.provide(cloud.layerFor(userId))),
    ),
  );
  /** A thread of the user's whose scripted turn has run to its end. */
  const thread = (id: string, text: string) =>
    rpc[ORCHESTRATION_V2_WS_METHODS.launchThread]({
      commandId: CommandId.make(`launch-${id}`),
      threadId: ThreadId.make(id),
      projectId: Environment.SCRATCH_PROJECT_ID,
      title: text,
      modelSelection: scriptedModelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      initialMessage: { messageId: MessageId.make(`message-${id}`), text, attachments: [] },
    }).pipe(Effect.andThen(cloud.settle), Effect.as(ThreadId.make(id)));
  /** An agent tool called from `threadId`'s machine. */
  const tool = (threadId: string, name: string, input: unknown) =>
    cloud.inUser(
      userId,
      CloudAutomations.use((automations) => automations.tool({ threadId }, name, input)),
    );
  /** Saves `source` from `threadId`, compiled where the thread's machine compiles it. */
  const save = (threadId: string, source: string) => {
    const compiled = compileWorkflow(source);
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
    return tool(threadId, "automation_save", { source, compiled: compiled.workflow });
  };
  const engine = <A, E>(use: (engine: WorkflowEngine.WorkflowEngineShape) => Effect.Effect<A, E>) =>
    cloud.inUser(userId, WorkflowEngine.WorkflowEngine.use(use));
  return { cloud, rpc, thread, tool, save, engine };
});

describe("cloud automations", () => {
  it.effect("an event trigger runs on a thread's turn with no client open", () =>
    Effect.gen(function* () {
      const { thread, save, engine } = yield* setup;
      const writer = yield* thread("thread-writer", "Write an automation");
      const saved = (yield* save(
        writer,
        `export const meta = { name: "Note turns", triggers: [{ on: "turn.finished" }] } as const;
export default workflow(async (w, event: { threadId: string }) => {
  await w.notify("Note it", \`A turn finished in \${event.threadId}\`);
  return "noted";
});`,
      )) as { readonly ok: boolean; readonly automation: { readonly automationId: string } };
      expect(saved.ok).toBe(true);

      yield* thread("thread-work", "Do some work");
      const { runs } = yield* engine((engine) => engine.get(saved.automation.automationId));
      expect(runs.map((run) => [run.trigger, run.status])).toEqual([["event", "succeeded"]]);
      const run = yield* engine((engine) => engine.getRun(runs[0]!.id));
      expect(run.output).toBe("noted");
    }),
  );

  it.effect("a wait wakes its thread from the object's alarm", () =>
    Effect.gen(function* () {
      const { cloud, thread, tool, rpc } = yield* setup;
      const agent = yield* thread("thread-agent", "Check back later");
      const at = Date.parse("2030-01-01T10:00:00.000Z");
      const wait = (yield* tool(agent, "wait_for", {
        until: "ten o'clock",
        at: new Date(at).toISOString(),
        message: "Look at the build again.",
      })) as { readonly waitId: string };
      expect(wait.waitId).toBeTruthy();
      // The alarm is set for it.
      expect(cloud.alarmAt(userId)).toBe(at);

      // The alarm fires once the time comes, and the agent gets its message.
      yield* cloud.inUser(
        userId,
        TestClock.setTime(at + 1_000).pipe(
          Effect.andThen(CloudAutomations.use((automations) => automations.wake)),
          Effect.provide(TestClock.layer()),
        ),
      );
      yield* cloud.settle;
      const projection = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
        threadId: agent,
      });
      expect(
        projection.messages.some((message) => message.text.includes("Look at the build again.")),
      ).toBe(true);
    }),
  );

  it.effect("an ask waits on the person, and their answer from the app carries the run on", () =>
    Effect.gen(function* () {
      const { thread, save, tool, rpc, engine } = yield* setup;
      const writer = yield* thread("thread-asker", "Ask me something");
      yield* save(
        writer,
        `export const meta = { name: "Ask first" } as const;
export default workflow(async (w) => {
  const answer = await w.ask("Ship it?", { options: ["ship", "hold"] });
  return answer;
});`,
      );
      const automation = (yield* engine((engine) => engine.list())).find(
        (entry) => entry.name === "Ask first",
      );
      const started = (yield* tool(writer, "automation_run", {
        automationId: automation?.id,
      })) as { readonly run: { readonly runId: string } };
      const waiting = yield* engine((engine) => engine.getRun(started.run.runId));
      const ask = waiting.steps.find((step) => step.verb === "ask");
      expect(ask?.status).toBe("waiting");

      yield* rpc[AUTOMATION_WS_METHODS.automationsAnswer]({
        runId: started.run.runId,
        stepKey: ask!.key,
        choice: "ship",
      });
      const done = yield* engine((engine) => engine.getRun(started.run.runId));
      expect([done.run.status, done.output]).toEqual(["succeeded", "ship"]);
    }),
  );
});
