// @effect-diagnostics globalDateInEffect:off - these tests fake `Date` for the Workflow instances' clock.
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
import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";
import * as SqlClient from "effect/sql/SqlClient";

// The machine compiles saves (oxc can't run in workerd); tests compile the same way it does.
import { compileWorkflow } from "../../../server/src/workflows/compiler/compileWorkflow.ts";
import * as Environment from "../environment.ts";
import { makeMemoryCloud } from "../testing.ts";
import { scriptedModelSelection } from "../thread/scriptedProvider.ts";
import * as CloudRpc from "../user/rpc.ts";
import { CloudAutomations } from "./CloudAutomations.ts";

/**
 * #434: a user's automations run with no client connected, each run a
 * Workflow instance of the real runtime (`memoryWorkflows.ts`). Thread events
 * arrive from the thread objects, sleeps and waits are the instance's, crons
 * fire on the object's alarm, and asks wait for the person.
 */

afterEach(() => {
  vi.useRealTimers();
});

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
  /** Starts the automation called `name` from `threadId`, and lets its run go until it blocks. */
  const start = (threadId: string, name: string) =>
    Effect.gen(function* () {
      const automation = (yield* engine((engine) => engine.list())).find(
        (entry) => entry.name === name,
      );
      const started = (yield* tool(threadId, "automation_run", {
        automationId: automation?.id,
      })) as { readonly run: { readonly runId: string } };
      yield* cloud.settle;
      return started.run.runId;
    });
  return { cloud, rpc, thread, tool, save, engine, start };
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

  it.effect("a timed wait sleeps in its instance and wakes its thread", () =>
    Effect.gen(function* () {
      vi.useFakeTimers({ toFake: ["Date"] });
      const { cloud, thread, tool, rpc } = yield* setup;
      const agent = yield* thread("thread-agent", "Check back later");
      const at = Date.now() + 3_600_000;
      const wait = (yield* tool(agent, "wait_for", {
        until: "an hour from now",
        at: new Date(at).toISOString(),
        message: "Look at the build again.",
      })) as { readonly waitId: string };
      yield* cloud.settle;
      // The instance sleeps; the object's alarm is only for crons.
      expect(cloud.workflows.instance(wait.waitId)?.workflows.blocked()).toEqual([
        expect.stringContaining("~sleep"),
      ]);
      expect(cloud.alarmAt(userId)).toBeUndefined();

      yield* cloud.workflows.advance(3_600_000 + 1_000);
      yield* cloud.settle;
      const projection = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
        threadId: agent,
      });
      expect(
        projection.messages.some((message) => message.text.includes("Look at the build again.")),
      ).toBe(true);
    }),
  );

  it.effect("a cron fires on the object's alarm", () =>
    Effect.gen(function* () {
      vi.useFakeTimers({ toFake: ["Date"] });
      const { cloud, thread, save, engine } = yield* setup;
      const writer = yield* thread("thread-cron", "Every minute");
      const saved = (yield* save(
        writer,
        `export const meta = { name: "Tick", triggers: [{ cron: "*/5 * * * *" }] } as const;
export default workflow(async (w) => {
  await w.notify("Tick", "Five minutes passed");
  return "ticked";
});`,
      )) as { readonly ok: boolean; readonly automation: { readonly automationId: string } };
      expect(saved.ok).toBe(true);
      const due = cloud.alarmAt(userId);
      expect(due).toBeDefined();

      vi.setSystemTime(due! + 1_000);
      yield* cloud.fireAlarm(userId);
      yield* cloud.settle;
      const { runs } = yield* engine((engine) => engine.get(saved.automation.automationId));
      expect(runs.map((run) => [run.trigger, run.status])).toEqual([["cron", "succeeded"]]);
      // And the alarm is set for the next one.
      expect(cloud.alarmAt(userId)).toBeGreaterThan(due!);
    }),
  );

  it.effect("an ask waits on the person, and their answer from the app carries the run on", () =>
    Effect.gen(function* () {
      const { cloud, thread, save, rpc, engine, start } = yield* setup;
      const writer = yield* thread("thread-asker", "Ask me something");
      yield* save(
        writer,
        `export const meta = { name: "Ask first" } as const;
export default workflow(async (w) => {
  const answer = await w.ask("Ship it?", { options: ["ship", "hold"] });
  return answer;
});`,
      );
      const runId = yield* start(writer, "Ask first");
      const waiting = yield* engine((engine) => engine.getRun(runId));
      const ask = waiting.steps.find((step) => step.verb === "ask");
      expect(ask?.status).toBe("waiting");

      yield* rpc[AUTOMATION_WS_METHODS.automationsAnswer]({
        runId,
        stepKey: ask!.key,
        choice: "ship",
      });
      yield* cloud.settle;
      const done = yield* engine((engine) => engine.getRun(runId));
      expect([done.run.status, done.output]).toEqual(["succeeded", "ship"]);
    }),
  );

  it.effect("a run finishes on the version it started on after a new one is saved", () =>
    Effect.gen(function* () {
      const { cloud, thread, save, rpc, engine, start } = yield* setup;
      const writer = yield* thread("thread-versions", "Version me");
      const version = (answer: string) => `export const meta = { name: "Pinned" } as const;
export default workflow(async (w) => {
  const choice = await w.ask("Which way?", { options: ["left", "right"] });
  return \`${answer}: \${choice}\`;
});`;
      yield* save(writer, version("one"));
      const runId = yield* start(writer, "Pinned");
      const waiting = yield* engine((engine) => engine.getRun(runId));
      const ask = waiting.steps.find((step) => step.verb === "ask");

      // Version 2 is saved while version 1's run waits.
      yield* save(writer, version("two"));
      yield* rpc[AUTOMATION_WS_METHODS.automationsAnswer]({
        runId,
        stepKey: ask!.key,
        choice: "left",
      });
      yield* cloud.settle;
      const done = yield* engine((engine) => engine.getRun(runId));
      expect([done.run.version, done.run.status, done.output]).toEqual([
        1,
        "succeeded",
        "one: left",
      ]);
    }),
  );

  it.effect("a version saved without cloud code fails its run with what to do", () =>
    Effect.gen(function* () {
      const { thread, tool, engine } = yield* setup;
      const writer = yield* thread("thread-old", "An old save");
      const source = `export const meta = { name: "Old save" } as const;
export default workflow(async (w) => "done");`;
      const compiled = compileWorkflow(source);
      if (!compiled.ok) return expect.unreachable();
      const { workerModule: _dropped, ...withoutModule } = compiled.workflow;
      yield* tool(writer, "automation_save", { source, compiled: withoutModule });
      const automation = (yield* engine((engine) => engine.list())).find(
        (entry) => entry.name === "Old save",
      );
      // The agent that starts it hears why, and the run shows it too.
      const started = yield* Effect.exit(
        tool(writer, "automation_run", { automationId: automation?.id }),
      );
      expect(started._tag).toBe("Failure");
      const { runs } = yield* engine((engine) => engine.get(automation!.id));
      expect([runs[0]?.status, runs[0]?.error]).toEqual([
        "failed",
        expect.stringContaining("Save the automation again"),
      ]);
    }),
  );

  it.effect("a run whose launch was cut off gets its instance when the object starts", () =>
    Effect.gen(function* () {
      const { cloud, thread, save, engine, start } = yield* setup;
      const writer = yield* thread("thread-cut", "Cut off");
      yield* save(
        writer,
        `export const meta = { name: "Cut off" } as const;
export default workflow(async (w) => w.ask("Still there?", { options: ["yes", "no"] }));`,
      );
      const runId = yield* start(writer, "Cut off");
      // As if the request ended between recording the run and confirming its instance.
      cloud.workflows.forget(runId);
      const unconfirm = SqlClient.SqlClient.use(
        (sql) =>
          sql`UPDATE signalbox_automation_runs SET instance_at = NULL WHERE run_id = ${runId}`,
      );
      // The object's SQLite is behind every user object, though not in the engine's own types.
      yield* cloud.inUser(userId, unconfirm as unknown as Effect.Effect<unknown>);
      yield* cloud.inUser(
        userId,
        CloudAutomations.use((automations) => automations.start),
      );
      yield* cloud.settle;
      expect(cloud.workflows.instance(runId)?.workflows.blocked()).toEqual([
        expect.stringContaining("~wait"),
      ]);
      const waiting = yield* engine((engine) => engine.getRun(runId));
      expect(waiting.steps.map((step) => [step.verb, step.status])).toEqual([["ask", "waiting"]]);
    }),
  );

  it.effect("an answer while the backend is down reaches the run once it's back", () =>
    Effect.gen(function* () {
      vi.useFakeTimers({ toFake: ["Date"] });
      const { cloud, thread, save, rpc, engine, start } = yield* setup;
      const writer = yield* thread("thread-outage", "Outage");
      yield* save(
        writer,
        `export const meta = { name: "Outage" } as const;
export default workflow(async (w) => w.ask("Go on?", { options: ["yes", "no"] }));`,
      );
      const runId = yield* start(writer, "Outage");
      const ask = (yield* engine((engine) => engine.getRun(runId))).steps.find(
        (step) => step.verb === "ask",
      );

      // The answer is taken even though the backend refuses its event.
      cloud.workflows.refuseEvents(1);
      yield* rpc[AUTOMATION_WS_METHODS.automationsAnswer]({
        runId,
        stepKey: ask!.key,
        choice: "yes",
      });
      yield* cloud.settle;
      expect((yield* engine((engine) => engine.getRun(runId))).run.status).toBe("running");
      const retryAt = cloud.alarmAt(userId);
      expect(retryAt).toBeDefined();

      // The object's alarm tells the instance again, and the run finishes.
      vi.setSystemTime(retryAt! + 1_000);
      yield* cloud.fireAlarm(userId);
      yield* cloud.settle;
      const done = yield* engine((engine) => engine.getRun(runId));
      expect([done.run.status, done.output]).toEqual(["succeeded", "yes"]);
    }),
  );
});
