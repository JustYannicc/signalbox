// @effect-diagnostics globalDateInEffect:off - these tests fake `Date` for the Workflow instances' clock.
import {
  AUTOMATION_WS_METHODS,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  CommandId,
  EnvironmentId,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  ThreadId,
} from "@t3tools/contracts";
import { scheduledTaskSource } from "@signalbox/automations/scheduledTasks";
import * as WorkflowEngine from "@signalbox/automations/WorkflowEngine";
import { SIGNALBOX_FOLDERS_WS_METHODS } from "@t3tools/contracts/signalboxFolders";
import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

// Machines and the CLI compile saves (oxc can't run in workerd); tests compile the same way.
import { compileForCloud } from "@signalbox/automation-compiler/compileForCloud";
import { compileWorkflow } from "@signalbox/automation-compiler/compileWorkflow";
import * as Environment from "../environment.ts";
import { makeMemoryCloud } from "../testing.ts";
import { scriptedModelSelection } from "../thread/scriptedProvider.ts";
import * as CloudRpc from "../user/rpc.ts";
import { PERSON_TIMEZONE_WS_METHODS } from "@t3tools/contracts/personTimezone";
import { SIGNALBOX_TRASH_WS_METHODS } from "@t3tools/contracts/signalboxTrash";
import * as CloudCompilerModule from "./cloudCompiler.ts";
import { CloudAutomations } from "./CloudAutomations.ts";
import { CloudCompiler } from "./cloudCompiler.ts";

/**
 * #434: a user's automations run with no client connected, each run a
 * Workflow instance of the real runtime (`memoryWorkflows.ts`). Thread events
 * arrive from the thread objects, sleeps and waits are the instance's, crons
 * fire on the object's alarm, and asks wait for the person.
 */

const initialTimezone = process.env.TZ;

afterEach(() => {
  vi.useRealTimers();
  if (initialTimezone === undefined) delete process.env.TZ;
  else process.env.TZ = initialTimezone;
});

// Scripted, so a person's saves have a model to run on without a pool.
const identity = {
  environmentId: EnvironmentId.make("cloud-test"),
  label: "Cloud",
  scripted: true,
};
const userId = "user_1";

/** `source` as a machine or the CLI sends it. */
const compiledOf = (source: string) => {
  const result = compileForCloud(source);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.compiled;
};

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
  const settingsRpc = yield* RpcTest.makeClient(CloudRpc.CloudRpcGroup).pipe(
    Effect.provide(
      Layer.mergeAll(
        CloudRpc.layerHandlers({ identity, userId, sid: "timezone-test" }),
        CloudRpc.layerScopeAuthorization([AuthOrchestrationReadScope, AuthSettingsWriteScope]),
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
  const save = (threadId: string, source: string) =>
    tool(threadId, "automation_save", { source, compiled: compiledOf(source) });
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
  return { cloud, rpc, settingsRpc, thread, tool, save, engine, start };
});

describe("cloud automations", () => {
  it.effect("restoring a trashed thread keeps its cancelled automation ask withdrawn", () =>
    Effect.gen(function* () {
      const { cloud, thread, save, rpc, engine } = yield* setup;
      const writer = yield* thread("thread-trashed-ask", "Prepare a decision");
      yield* save(
        writer,
        `export const meta = { name: "Trash decision" } as const;
export default workflow(async (w) => w.ask("Continue?", { options: ["yes", "no"] }));`,
      );
      const automation = (yield* engine((engine) => engine.list())).find(
        (entry) => entry.name === "Trash decision",
      )!;
      const started = yield* engine((engine) =>
        engine.startRun({
          automationId: automation.id,
          trigger: "manual",
          attach: { threadId: writer },
        }),
      );
      yield* cloud.settle;
      const pending = (yield* engine((engine) => engine.getRun(started.id))).steps[0]!.commonAsk!;
      expect(pending.status).toBe("pending");
      const trashed = yield* rpc[SIGNALBOX_TRASH_WS_METHODS.thread]({ threadId: writer });
      yield* cloud.settle;
      expect(
        (yield* engine((engine) => engine.getRun(started.id))).steps[0]!.commonAsk?.status,
      ).toBe("withdrawn");
      yield* rpc[SIGNALBOX_TRASH_WS_METHODS.restore]({ id: trashed.entries[0]!.id });
      const restored = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
        threadId: writer,
      });
      expect(restored.thread.asks?.find((ask) => ask.id === pending.id)?.status).toBe("withdrawn");
      expect(restored.thread.asks?.filter((ask) => ask.status === "pending")).toEqual([]);
    }),
  );
  it.effect("snapshots the saved zone for cron versions and drafts", () =>
    Effect.gen(function* () {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-17T06:00:00.000Z"));
      yield* TestClock.setTime(Date.now());
      const { cloud, rpc, settingsRpc, thread, tool, engine } = yield* setup;
      const writer = yield* thread("thread-timezone", "Write a scheduled automation");
      const setTimezone = (timezone: string) =>
        settingsRpc[PERSON_TIMEZONE_WS_METHODS.set]({ timezone });
      yield* setTimezone("Europe/Zurich");

      const source = `export const meta = { name: "Morning report", triggers: [{ cron: "0 9 * * *" }] } as const;
export default workflow(async (_w) => "morning");`;
      const compiled = compiledOf(source);
      const saved = (yield* tool(writer, "automation_save", { source, compiled })) as {
        readonly ok: true;
        readonly automation: { readonly automationId: string; readonly version: number };
      };
      const first = yield* engine((workflow) => workflow.get(saved.automation.automationId));
      expect(first.automation.triggers).toEqual([{ cron: "0 9 * * *", timezone: "Europe/Zurich" }]);
      expect(first.automation.nextRunAt).toBe("2026-10-17T07:00:00.000Z");
      expect(first.source).toBe(source);
      expect(compiled.meta.triggers).toEqual([{ cron: "0 9 * * *" }]);
      expect(
        yield* cloud.inUser(
          userId,
          CloudAutomations.use((automations) =>
            automations.workerModule(saved.automation.automationId, saved.automation.version),
          ),
        ),
      ).toBe(compiled.workerModule);
      expect(yield* tool(writer, "person_timezone", {})).toEqual({ timezone: "Europe/Zurich" });

      const rpcSource = `export const meta = { name: "RPC report", triggers: [{ cron: "0 10 * * *" }] } as const;
export default workflow(async (_w) => "rpc");`;
      const rpcSaved = yield* rpc[AUTOMATION_WS_METHODS.automationsSave]({
        source: rpcSource,
        projectId: Environment.SCRATCH_PROJECT_ID,
        compiled: compiledOf(rpcSource),
      });
      expect(rpcSaved.ok && rpcSaved.automation.triggers).toEqual([
        { cron: "0 10 * * *", timezone: "Europe/Zurich" },
      ]);

      const explicitSource = `export const meta = { name: "UTC report", triggers: [{ cron: "0 9 * * *", timezone: "UTC" }] } as const;
export default workflow(async (_w) => "utc");`;
      const explicit = (yield* tool(writer, "automation_save", {
        source: explicitSource,
        compiled: compiledOf(explicitSource),
      })) as { readonly automation: { readonly automationId: string } };
      expect(
        (yield* engine((workflow) => workflow.get(explicit.automation.automationId))).automation
          .triggers,
      ).toEqual([{ cron: "0 9 * * *", timezone: "UTC" }]);

      yield* setTimezone("America/Los_Angeles");
      const afterProfileChange = (yield* engine((workflow) =>
        workflow.get(saved.automation.automationId),
      )).automation;
      expect(afterProfileChange.triggers).toEqual([
        { cron: "0 9 * * *", timezone: "Europe/Zurich" },
      ]);
      expect(afterProfileChange.nextRunAt).toBe(first.automation.nextRunAt);

      const draftSource = source
        .replace('"0 9 * * *"', '"0 8 * * *"')
        .replace("morning", "morning edited");
      const draft = compiledOf(draftSource);
      yield* tool(writer, "automation_save", {
        source: draftSource,
        compiled: draft,
        automationId: saved.automation.automationId,
        draft: true,
      });
      yield* setTimezone("Asia/Tokyo");
      const resavedDraftSource = draftSource.replace("morning edited", "morning final");
      const resavedDraft = compiledOf(resavedDraftSource);
      yield* tool(writer, "automation_save", {
        source: resavedDraftSource,
        compiled: resavedDraft,
        automationId: saved.automation.automationId,
        draft: true,
      });
      yield* tool(writer, "automation_publish", {
        automationId: saved.automation.automationId,
      });
      const published = yield* engine((workflow) => workflow.get(saved.automation.automationId));
      expect(published.automation.triggers).toEqual([
        { cron: "0 8 * * *", timezone: "America/Los_Angeles" },
      ]);
      expect(published.automation.nextRunAt).toBe("2026-10-17T15:00:00.000Z");
      expect(published.source).toBe(resavedDraftSource);
      expect(
        yield* cloud.inUser(
          userId,
          CloudAutomations.use((automations) =>
            automations.workerModule(saved.automation.automationId, published.automation.version),
          ),
        ),
      ).toBe(resavedDraft.workerModule);
    }),
  );

  it.effect("keeps an existing implicit cron on UTC when resaved", () =>
    Effect.gen(function* () {
      process.env.TZ = "UTC";
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-17T06:00:00.000Z"));
      yield* TestClock.setTime(Date.now());
      const { cloud, settingsRpc, thread, tool, engine } = yield* setup;
      const writer = yield* thread("thread-legacy-timezone", "Write a legacy automation");
      const source = `export const meta = { name: "Legacy report", triggers: [{ cron: "0 9 * * *" }] } as const;
export default workflow(async (_w) => "legacy");`;
      const compiled = compiledOf(source);
      const result = yield* cloud.inUser(
        userId,
        Effect.gen(function* () {
          const compiler = yield* CloudCompiler;
          const workflow = yield* WorkflowEngine.WorkflowEngine;
          return yield* compiler.withStaged(
            source,
            yield* CloudCompilerModule.acceptCompiled(compiled),
            workflow.save({
              source,
              projectId: Environment.SCRATCH_PROJECT_ID,
              defaults: {
                modelSelection: scriptedModelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
              },
            }),
          );
        }),
      );
      if (!result.ok) return yield* Effect.die(result.diagnostics);
      const legacyId = result.automation.id;
      const original = yield* engine((workflow) => workflow.get(legacyId));
      expect(original.automation.triggers).toEqual([{ cron: "0 9 * * *" }]);
      expect(original.automation.nextRunAt).toBe("2026-10-17T09:00:00.000Z");

      yield* settingsRpc[PERSON_TIMEZONE_WS_METHODS.set]({ timezone: "Europe/Zurich" });
      const untouched = (yield* engine((workflow) => workflow.get(legacyId))).automation;
      expect(untouched.triggers).toEqual([{ cron: "0 9 * * *" }]);
      expect(untouched.nextRunAt).toBe(original.automation.nextRunAt);

      const resavedSource = source.replace("legacy", "edited legacy");
      yield* tool(writer, "automation_save", {
        source: resavedSource,
        compiled: compiledOf(resavedSource),
        automationId: legacyId,
      });
      const resaved = (yield* engine((workflow) => workflow.get(legacyId))).automation;
      expect(resaved.triggers).toEqual([{ cron: "0 9 * * *", timezone: "UTC" }]);
      expect(resaved.nextRunAt).toBe(original.automation.nextRunAt);
    }),
  );

  it.effect("preserves each duplicate cron's zone across live and draft resaves", () =>
    Effect.gen(function* () {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-17T06:00:00.000Z"));
      yield* TestClock.setTime(Date.now());
      const { rpc, settingsRpc, thread, tool, engine } = yield* setup;
      const writer = yield* thread("thread-duplicate-zones", "Keep both scheduled times");
      yield* settingsRpc[PERSON_TIMEZONE_WS_METHODS.set]({ timezone: "Europe/Zurich" });
      const source = `export const meta = { name: "Two mornings", triggers: [{ cron: "0 9 * * *", timezone: "UTC" }, { cron: "0 9 * * *" }] } as const;
export default workflow(async (_w) => "morning");`;
      const saved = yield* rpc[AUTOMATION_WS_METHODS.automationsSave]({
        source,
        projectId: Environment.SCRATCH_PROJECT_ID,
        compiled: compiledOf(source),
      });
      if (!saved.ok) return yield* Effect.die(saved.diagnostics);
      const automationId = saved.automation.id;
      const expected = [
        { cron: "0 9 * * *", timezone: "UTC" },
        { cron: "0 9 * * *", timezone: "Europe/Zurich" },
      ];
      yield* settingsRpc[PERSON_TIMEZONE_WS_METHODS.set]({ timezone: "Asia/Tokyo" });
      for (const draft of [false, true]) {
        yield* tool(writer, "automation_save", {
          source,
          compiled: compiledOf(source),
          automationId,
          draft,
        });
        if (draft) {
          // The second save must use the saved draft's zones too.
          yield* tool(writer, "automation_save", {
            source,
            compiled: compiledOf(source),
            automationId,
            draft,
          });
          yield* tool(writer, "automation_publish", { automationId });
        }
        const current = (yield* engine((workflow) => workflow.get(automationId))).automation;
        expect(current.triggers).toEqual(expected);
        expect(current.nextRunAt).toBe("2026-10-17T07:00:00.000Z");
      }
    }),
  );

  it.effect("keeps implicit cron zones when explicit duplicates change or move", () =>
    Effect.gen(function* () {
      const { rpc, settingsRpc, thread, tool, engine } = yield* setup;
      const writer = yield* thread("thread-edited-duplicate-zones", "Edit one scheduled time");
      for (const draft of [false, true]) {
        for (const reordered of [false, true]) {
          yield* settingsRpc[PERSON_TIMEZONE_WS_METHODS.set]({ timezone: "Europe/Zurich" });
          const name = `Edited mornings ${draft} ${reordered}`;
          const explicit = { cron: "0 9 * * *", timezone: "UTC" };
          const implicit = { cron: "0 9 * * *" };
          const sourceOf = (triggers: ReadonlyArray<typeof implicit | typeof explicit>) =>
            `export const meta = ${JSON.stringify({ name, triggers })} as const;
export default workflow(async (_w) => "morning");`;
          const source = sourceOf([explicit, implicit]);
          const saved = yield* rpc[AUTOMATION_WS_METHODS.automationsSave]({
            source,
            projectId: Environment.SCRATCH_PROJECT_ID,
            compiled: compiledOf(source),
          });
          if (!saved.ok) return yield* Effect.die(saved.diagnostics);
          const automationId = saved.automation.id;
          yield* settingsRpc[PERSON_TIMEZONE_WS_METHODS.set]({ timezone: "America/New_York" });
          const edited = { ...explicit, timezone: "Asia/Tokyo" };
          const triggers = reordered ? [implicit, edited] : [edited, implicit];
          const editedSource = sourceOf(triggers);
          // A second draft save checks that provenance survives persisted metadata decoding.
          for (let save = 0; save < (draft ? 2 : 1); save++) {
            yield* tool(writer, "automation_save", {
              source: editedSource,
              compiled: compiledOf(editedSource),
              automationId,
              draft,
            });
          }
          if (draft) yield* tool(writer, "automation_publish", { automationId });
          const current = (yield* engine((workflow) => workflow.get(automationId))).automation;
          expect(current.triggers).toEqual(
            triggers.map((trigger) => ({
              ...trigger,
              timezone: "timezone" in trigger ? trigger.timezone : "Europe/Zurich",
            })),
          );
        }
      }
    }),
  );

  it.effect("keeps local time across DST and a non-hour timezone offset", () =>
    Effect.gen(function* () {
      vi.useFakeTimers({ toFake: ["Date"] });
      const { rpc, settingsRpc } = yield* setup;
      const cases = [
        {
          zone: "Europe/Zurich",
          from: "2026-03-28T06:00:00.000Z",
          next: "2026-03-28T08:00:00.000Z",
        },
        {
          zone: "Europe/Zurich",
          from: "2026-03-29T06:00:00.000Z",
          next: "2026-03-29T07:00:00.000Z",
        },
        {
          zone: "Europe/Zurich",
          from: "2026-10-24T06:00:00.000Z",
          next: "2026-10-24T07:00:00.000Z",
        },
        {
          zone: "Europe/Zurich",
          from: "2026-10-25T06:00:00.000Z",
          next: "2026-10-25T08:00:00.000Z",
        },
        {
          zone: "Asia/Kathmandu",
          from: "2026-10-17T00:00:00.000Z",
          next: "2026-10-17T03:15:00.000Z",
        },
      ];
      for (const [index, { zone, from, next }] of cases.entries()) {
        vi.setSystemTime(new Date(from));
        yield* TestClock.setTime(Date.now());
        yield* settingsRpc[PERSON_TIMEZONE_WS_METHODS.set]({ timezone: zone });
        const source = `export const meta = { name: "Local morning ${index}", triggers: [{ cron: "0 9 * * *" }] } as const;
export default workflow(async (_w) => "morning");`;
        const saved = yield* rpc[AUTOMATION_WS_METHODS.automationsSave]({
          source,
          compiled: compiledOf(source),
          projectId: Environment.SCRATCH_PROJECT_ID,
        });
        expect(saved.ok && saved.automation.nextRunAt).toBe(next);
      }
    }),
  );

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

  it.effect("an agent and an automation move their folder to another phase", () =>
    Effect.gen(function* () {
      const { rpc, thread, tool, save } = yield* setup;
      const writer = yield* thread("thread-writer", "Plan the trip");
      const created = yield* rpc[SIGNALBOX_FOLDERS_WS_METHODS.create]({
        name: "Trip",
        parentId: null,
      });
      const trip = created.folders.find((folder) => folder.name === "Trip")!.id;
      const atTop = yield* Effect.exit(tool(writer, "set_folder_phase", { current: "Doing" }));
      expect(atTop._tag === "Failure" ? Cause.pretty(atTop.cause) : "moved").toContain("top level");

      // From its thread's machine, the agent's own folder.
      yield* rpc[SIGNALBOX_FOLDERS_WS_METHODS.moveThread]({ threadId: writer, folderId: trip });
      expect(yield* tool(writer, "set_folder_phase", { current: "doing" })).toEqual({
        folderId: trip,
        phase: { phases: ["Idea", "Doing", "Done"], current: "Doing" },
      });

      // An automation step: the folder of the thread whose turn finished.
      const saved = (yield* save(
        writer,
        `export const meta = { name: "Done on a turn", triggers: [{ on: "turn.finished" }] } as const;
export default workflow(async (w, event: { threadId: string }) => {
  await w.call("Mark it done", "signalbox.set_folder_phase", { threadId: event.threadId, current: "Done" });
});`,
      )) as { readonly ok: boolean };
      expect(saved.ok).toBe(true);
      yield* rpc[SIGNALBOX_FOLDERS_WS_METHODS.moveThread]({
        threadId: ThreadId.make("thread-work"),
        folderId: trip,
      });
      yield* thread("thread-work", "Book it");
      const after = yield* rpc[SIGNALBOX_FOLDERS_WS_METHODS.update]({ id: trip });
      expect(after.folders.find((folder) => folder.id === trip)?.phase?.current).toBe("Done");
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

  it.effect(
    "an agent's scheduled task posts into its thread on every cron, until deleted (#367)",
    () =>
      Effect.gen(function* () {
        vi.useFakeTimers({ toFake: ["Date"] });
        const { cloud, rpc, thread, save, tool, engine } = yield* setup;
        const agent = yield* thread("thread-clock", "Post the time every 5 minutes");
        const saved = (yield* save(
          agent,
          scheduledTaskSource({
            title: "Post the time",
            prompt: "Post the current time.",
            schedule: { type: "interval", everyMs: 300_000 },
            timezone: "UTC",
            threadId: agent,
            key: null,
          }),
        )) as { readonly ok: boolean; readonly automation: { readonly automationId: string } };
        expect(saved.ok).toBe(true);

        const posted = () =>
          rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({ threadId: agent }).pipe(
            Effect.map(
              (projection) =>
                projection.messages.filter((message) => message.text === "Post the current time.")
                  .length,
            ),
          );
        for (const expected of [1, 2]) {
          const due = cloud.alarmAt(userId)!;
          vi.setSystemTime(due + 1_000);
          yield* cloud.fireAlarm(userId);
          yield* cloud.settle;
          expect(yield* posted()).toBe(expected);
        }
        const { runs } = yield* engine((engine) => engine.get(saved.automation.automationId));
        expect(runs.map((run) => [run.trigger, run.status])).toEqual([
          ["cron", "succeeded"],
          ["cron", "succeeded"],
        ]);

        yield* tool(agent, "automation_delete", { automationId: saved.automation.automationId });
        vi.setSystemTime(Date.now() + 600_000);
        yield* cloud.fireAlarm(userId);
        yield* cloud.settle;
        expect(yield* posted()).toBe(2);
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

  it.effect("a common ask answer resumes the same cloud workflow with its form intact", () =>
    Effect.gen(function* () {
      const { cloud, thread, save, rpc, engine, start } = yield* setup;
      const writer = yield* thread("thread-common-ask", "Prepare a decision");
      yield* save(
        writer,
        `export const meta = { name: "Pick supplies" } as const;
export default workflow(async (w) => w.ask("Bring what?", {
  options: ["tea", "cake"], multi: true,
  fields: { count: { type: "number", required: true } },
}));`,
      );
      const runId = yield* start(writer, "Pick supplies");
      const pending = (yield* engine((engine) => engine.getRun(runId))).steps[0]!.commonAsk!;
      expect(pending.source).toMatchObject({ kind: "automation", runId });
      expect(pending.questions[0].surface).toMatchObject({
        kind: "kit",
        component: "automation",
        props: { fields: [{ name: "count", required: true }] },
      });
      const projected = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
        threadId: writer,
      });
      const ask = projected.thread.asks!.find(
        (entry) => entry.source.kind === "automation" && entry.source.runId === runId,
      )!;
      const command = {
        type: "thread.ask.answer" as const,
        commandId: CommandId.make("common-automation-answer"),
        threadId: writer,
        askId: ask.id,
        round: 1,
        answers: [
          {
            questionId: ask.questions[0].id,
            value: { choice: ["cake", "tea"], values: { count: 2 } },
          },
        ],
        deferredQuestionIds: [],
        answeredBy: { kind: "person" as const, personId: userId },
      };
      yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](command);
      yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](command);
      yield* cloud.settle;
      const done = yield* engine((engine) => engine.getRun(runId));
      expect(done).toMatchObject({
        run: { status: "succeeded" },
        output: { choice: ["tea", "cake"], values: { count: 2 } },
      });
      const latest = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
        threadId: writer,
      });
      expect(latest.thread.asks!.find((entry) => entry.id === ask.id)).toEqual(
        done.steps[0]!.commonAsk,
      );
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
      const { cloud, thread, tool, engine } = yield* setup;
      const writer = yield* thread("thread-old", "An old save");
      const source = `export const meta = { name: "Old save" } as const;
export default workflow(async (w) => "done");`;
      const compiled = compileWorkflow(source);
      if (!compiled.ok) return expect.unreachable();
      const { workerModule: _dropped, ...withoutModule } = compiled.workflow;
      // Saves are checked now, so the old version goes in under the check.
      yield* cloud.inUser(
        userId,
        Effect.gen(function* () {
          const compiler = yield* CloudCompiler;
          const engine = yield* WorkflowEngine.WorkflowEngine;
          yield* compiler.withStaged(
            source,
            withoutModule,
            engine.save({
              source,
              projectId: Environment.SCRATCH_PROJECT_ID,
              defaults: {
                modelSelection: scriptedModelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
              },
            }),
          );
        }),
      );
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

/**
 * #558: the `signalbox` CLI and stdio `signalbox mcp` compile on the person's
 * computer and send `compiled`; the cloud checks it before saving. Remote
 * `/mcp` and the app can't compile, so they're told where saving works.
 */
describe("saving automations compiled outside the cloud", () => {
  const source = `export const meta = { name: "From my laptop" } as const;
export default workflow(async (w) => "hello");`;
  const failureOf = <A, E extends { readonly message: string }>(effect: Effect.Effect<A, E>) =>
    Effect.flip(effect).pipe(Effect.map((error) => error.message));

  it.effect("saves what the caller compiled, and it runs", () =>
    Effect.gen(function* () {
      const { cloud, rpc, engine } = yield* setup;
      const saved = yield* rpc[AUTOMATION_WS_METHODS.automationsSave]({
        source,
        projectId: Environment.SCRATCH_PROJECT_ID,
        compiled: compiledOf(source),
      });
      if (!saved.ok) return expect.unreachable();
      const run = yield* rpc[AUTOMATION_WS_METHODS.automationsRunNow]({
        automationId: saved.automation.id,
      });
      yield* cloud.settle;
      const { runs } = yield* engine((engine) => engine.get(saved.automation.id));
      expect(runs.map((entry) => [entry.id, entry.status])).toEqual([[run.id, "succeeded"]]);
      expect((yield* engine((engine) => engine.getRun(run.id))).output).toBe("hello");
    }),
  );

  it.effect("validates what the caller compiled", () =>
    Effect.gen(function* () {
      const { rpc } = yield* setup;
      const compiled = compiledOf(source);
      const checked = yield* rpc[AUTOMATION_WS_METHODS.automationsValidate]({ source, compiled });
      expect(checked).toEqual({ ok: true, graph: compiled.graph });
    }),
  );

  it.effect("says where saving works when nothing was compiled", () =>
    Effect.gen(function* () {
      const { rpc } = yield* setup;
      const saving = yield* failureOf(
        rpc[AUTOMATION_WS_METHODS.automationsSave]({
          source,
          projectId: Environment.SCRATCH_PROJECT_ID,
        }),
      );
      const checking = yield* failureOf(rpc[AUTOMATION_WS_METHODS.automationsValidate]({ source }));
      for (const message of [saving, checking]) {
        expect(message).toContain("signalbox mcp");
        expect(message).toContain("signalbox automations");
      }
    }),
  );

  it.effect("refuses compiled code of another format or shape", () =>
    Effect.gen(function* () {
      const { rpc, thread, tool, engine } = yield* setup;
      const compiled = compiledOf(source);
      const save = (candidate: typeof compiled) =>
        failureOf(
          rpc[AUTOMATION_WS_METHODS.automationsSave]({
            source,
            projectId: Environment.SCRATCH_PROJECT_ID,
            compiled: candidate,
          }),
        );
      expect(yield* save({ ...compiled, format: compiled.format + 1 })).toContain(
        "Update signalbox",
      );
      expect(yield* save({ ...compiled, workerModule: "export default {}" })).toContain(
        "isn't a compiled automation",
      );
      // A thread's machine gets the same check.
      const writer = yield* thread("thread-forged", "Forge it");
      // The test object turns failures into defects; the message is what matters.
      const refusal = (candidate: unknown) =>
        tool(writer, "automation_save", { source, compiled: candidate }).pipe(
          Effect.exit,
          Effect.map((exit) => (exit._tag === "Failure" ? Cause.pretty(exit.cause) : "saved")),
        );
      expect(yield* refusal({ ...compiled, format: 99 })).toContain("Update signalbox");
      expect(yield* refusal({ script: 1 })).toContain("isn't a compiled automation");
      const automations = yield* engine((engine) => engine.list());
      expect(
        automations.filter(
          (automation) => automation.name !== "Task done" && automation.name !== "Settle task",
        ),
      ).toEqual([]);
    }),
  );
});
