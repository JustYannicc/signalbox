import { describe, expect, it } from "@effect/vitest";
import type { ToolRequest, ToolResult } from "@signalbox/runner-protocol/AutomationProtocol";
import * as Effect from "effect/Effect";

import { serve } from "./RunnerAutomationTools.testkit.ts";
import { RUNNER_SCHEDULED_TASK_TOOLS } from "./RunnerScheduledTaskTools.ts";

/**
 * Upstream's scheduled-task tools on a cloud thread's machine (#367): each
 * task is an automation in the thread's folder on the cloud's engine. The
 * fake engine keeps automations the way the cloud's tools answer them.
 */

const THREAD = "thread_cloud_1";
const FOLDER = "project_folder_1";

interface Saved {
  summary: Record<string, unknown>;
  source: string;
  draft?: { version: number; source: string; outline: string };
}

const fakeEngine = (timezone = "Europe/Zurich") => {
  const automations = new Map<string, Saved>();
  let next = 0;
  const ok = (result: unknown): ToolResult => ({ _tag: "ok", result });
  const respond = (request: ToolRequest): ToolResult => {
    const input = (request.input ?? {}) as Record<string, any>;
    switch (request.name) {
      case "person_timezone":
        return ok({ timezone });
      case "automation_list":
        return ok({ automations: [...automations.values()].map((a) => a.summary), builtIns: [] });
      case "automation_read": {
        const saved = automations.get(input.automationId);
        if (!saved) return { _tag: "failed", message: `No automation ${input.automationId}.` };
        return ok({
          automation: saved.summary,
          intent: null,
          source: saved.source,
          outline: "",
          draft: saved.draft ?? null,
          runs: [],
          webhookRejections: [],
        });
      }
      case "automation_save": {
        const meta = input.compiled.meta as { name: string; description?: string; triggers: any[] };
        const taken = [...automations.values()].find(
          (a) => a.summary.name === meta.name && a.summary.automationId !== input.automationId,
        );
        // The engine saves by name in a folder: the same name updates that automation.
        const automationId: string =
          input.automationId ?? taken?.summary.automationId ?? `automation_${++next}`;
        const summary = {
          automationId,
          name: meta.name,
          description: meta.description ?? null,
          projectId: input.projectId ?? FOLDER,
          enabled: automations.get(automationId)?.summary.enabled ?? true,
          version: 1,
          draftVersion: null,
          triggers: meta.triggers.map((t) => `cron ${t.cron} (${t.timezone})`),
          nextRunAt: "2026-10-16T10:05:00.000Z",
          webhook: null,
          lastRun: null,
        };
        automations.set(automationId, { summary, source: input.source });
        return ok({ ok: true, automation: summary, outline: "" });
      }
      case "automation_set_enabled": {
        const saved = automations.get(input.automationId)!;
        saved.summary = { ...saved.summary, enabled: input.enabled };
        return ok({ automation: saved.summary });
      }
      case "automation_delete":
        automations.delete(input.automationId);
        return ok({});
      case "automation_run":
        return ok({
          run: {
            runId: "run_1",
            status: "running",
            trigger: "manual",
            startedAt: "2026-10-16T10:01:00.000Z",
            finishedAt: null,
            error: null,
            errorDetail: null,
            waitingOnYou: false,
            retryOf: null,
          },
        });
      default:
        return { _tag: "failed", message: `unexpected ${request.name}` };
    }
  };
  return { automations, respond };
};

const setup = Effect.gen(function* () {
  const engine = fakeEngine();
  const tools = yield* serve({ threadId: THREAD, respond: engine.respond });
  const json = (name: string, args: Record<string, unknown>) =>
    Effect.map(tools.call(name, args), (answer) => ({
      isError: answer.isError === true,
      text: answer.content[0]?.text ?? "",
      value: answer.isError ? undefined : JSON.parse(answer.content[0]!.text),
    }));
  return { ...tools, engine, json };
});

const saves = (requests: ReadonlyArray<ToolRequest>) =>
  requests.filter((request) => request.name === "automation_save");

describe("scheduled tasks on a cloud thread's machine (#367)", () => {
  it.effect("are served beside the automation tools", () =>
    Effect.gen(function* () {
      const { mcp } = yield* setup;
      const names = (
        (yield* mcp("tools/list", {})).result.tools as ReadonlyArray<{ name: string }>
      ).map((tool) => tool.name);
      expect(names).toEqual(expect.arrayContaining([...RUNNER_SCHEDULED_TASK_TOOLS]));
    }),
  );

  it.effect("schedule_task saves a cron automation that wakes this thread", () =>
    Effect.gen(function* () {
      const { json, cloud, engine } = yield* setup;
      const scheduled = yield* json("schedule_task", {
        prompt: "Post the current time.",
        schedule: { type: "interval", everyMs: 300_000 },
      });
      expect(scheduled.isError).toBe(false);
      expect(scheduled.value).toMatchObject({
        scheduledTaskId: "automation_1",
        automationId: "automation_1",
        title: "Post the current time.",
        prompt: "Post the current time.",
        enabled: true,
        projectId: FOLDER,
        boundThreadId: THREAD,
        schedule: { type: "interval", everyMs: 300_000 },
        nextRunAt: "2026-10-16T10:05:00.000Z",
        lastRunStatus: "never",
      });

      const [save] = saves(cloud.requests);
      const input = save!.input as { source: string; compiled: any; projectId?: string };
      // The thread's folder: the cloud places it where the caller lives.
      expect(input.projectId).toBeUndefined();
      expect(input.compiled.meta.triggers).toEqual([{ cron: "*/5 * * * *", timezone: "UTC" }]);
      expect(cloud.requests.some((request) => request.name === "person_timezone")).toBe(false);
      expect(input.source).toContain(`"signalbox.t3_thread_send"`);
      expect(input.source).toContain(`threadId: "thread_cloud_1"`);
      expect(engine.automations.size).toBe(1);
    }),
  );

  it.effect("keeps a fixed time in the zone asked for, and refuses one it doesn't know", () =>
    Effect.gen(function* () {
      const { json, cloud } = yield* setup;
      const scheduled = yield* json("schedule_task", {
        title: "Standup",
        prompt: "Summarize yesterday.",
        schedule: { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] },
        timezone: "Europe/Zurich",
        bindToCurrentThread: false,
      });
      expect(scheduled.value).toMatchObject({ title: "Standup", boundThreadId: null });
      const input = saves(cloud.requests)[0]!.input as { source: string; compiled: any };
      expect(input.compiled.meta.triggers).toEqual([
        { cron: "0 9 * * 1,2,3,4,5", timezone: "Europe/Zurich" },
      ]);
      expect(cloud.requests.some((request) => request.name === "person_timezone")).toBe(false);
      expect(input.source).toContain(`w.agent("Run the prompt"`);

      const refused = yield* json("schedule_task", {
        prompt: "Nope.",
        schedule: { type: "fixed_time", timeOfDay: "09:00" },
        timezone: "Mars/Olympus",
      });
      expect(refused).toMatchObject({ isError: true });
      expect(refused.text).toContain("Mars/Olympus");
      expect(saves(cloud.requests)).toHaveLength(1);
    }),
  );

  it.effect("keeps an explicit interval timezone", () =>
    Effect.gen(function* () {
      const { json, cloud } = yield* setup;
      yield* json("schedule_task", {
        prompt: "Check the queue.",
        schedule: { type: "interval", everyMs: 300_000 },
        timezone: "America/New_York",
      });
      const input = saves(cloud.requests)[0]!.input as { compiled: any };
      expect(input.compiled.meta.triggers).toEqual([
        { cron: "*/5 * * * *", timezone: "America/New_York" },
      ]);
      expect(cloud.requests.some((request) => request.name === "person_timezone")).toBe(false);
    }),
  );

  it.effect("defaults a new fixed time to the person's saved timezone", () =>
    Effect.gen(function* () {
      const { json, cloud } = yield* setup;
      const scheduled = yield* json("schedule_task", {
        title: "Standup",
        prompt: "Summarize yesterday.",
        schedule: { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] },
      });
      expect(scheduled.isError).toBe(false);
      expect(scheduled.value).toMatchObject({ timezone: "Europe/Zurich" });
      expect(cloud.requests.map((request) => request.name)).toContain("person_timezone");
      const input = saves(cloud.requests)[0]!.input as { source: string; compiled: any };
      expect(input.compiled.meta.triggers).toEqual([
        { cron: "0 9 * * 1,2,3,4,5", timezone: "Europe/Zurich" },
      ]);
    }),
  );

  it.effect("says webhooks don't run in the cloud yet, and saves nothing", () =>
    Effect.gen(function* () {
      const { json, cloud } = yield* setup;
      const refused = yield* json("schedule_task", {
        prompt: "Handle {{body.action}}.",
        schedule: { type: "webhook" },
      });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain("webhook");
      expect(cloud.requests).toEqual([]);
    }),
  );

  it.effect("saves one automation for a retried request, and never takes another's name", () =>
    Effect.gen(function* () {
      const { json, cloud, engine } = yield* setup;
      engine.respond({
        name: "automation_save",
        input: {
          source: "// someone's own",
          compiled: { meta: { name: "Post the time", triggers: [] } },
        },
      });
      const request = {
        title: "Post the time",
        prompt: "Post the current time.",
        schedule: { type: "interval", everyMs: 300_000 },
        clientRequestId: "req-1",
      };
      const first = yield* json("schedule_task", request);
      const again = yield* json("schedule_task", request);
      expect(first.value.title).toBe("Post the time (2)");
      expect(again.value.scheduledTaskId).toBe(first.value.scheduledTaskId);
      expect(saves(cloud.requests)).toHaveLength(1);
      expect(engine.automations.get("automation_1")!.source).toBe("// someone's own");
    }),
  );

  it.effect("leaves a task with a draft waiting alone", () =>
    Effect.gen(function* () {
      const { json, cloud, engine } = yield* setup;
      const { value: task } = yield* json("schedule_task", {
        prompt: "Post the current time.",
        schedule: { type: "interval", everyMs: 300_000 },
      });
      engine.automations.get(task.automationId)!.draft = {
        version: 2,
        source: "// someone's review",
        outline: "",
      };
      const refused = yield* json("update_scheduled_task", {
        scheduledTaskId: task.scheduledTaskId,
        prompt: "Post the date.",
      });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain("draft");
      expect(saves(cloud.requests)).toHaveLength(1);
    }),
  );

  it.effect("lists, updates, runs and deletes the tasks it made", () =>
    Effect.gen(function* () {
      const { json, cloud, engine } = yield* setup;
      const { value: task } = yield* json("schedule_task", {
        prompt: "Post the current time.",
        schedule: { type: "interval", everyMs: 300_000 },
      });
      // An automation someone wrote, and one that was a task until someone changed it.
      engine.respond({
        name: "automation_save",
        input: { source: "// own", compiled: { meta: { name: "Weekly report", triggers: [] } } },
      });
      const { value: changed } = yield* json("schedule_task", {
        title: "Changed",
        prompt: "Original.",
        schedule: { type: "interval", everyMs: 3_600_000 },
      });
      const edited = engine.automations.get(changed.automationId)!;
      edited.source = edited.source.replace("Original.", "Edited by hand.");

      const listed = yield* json("list_scheduled_tasks", {});
      expect(listed.value.tasks.map((t: { scheduledTaskId: string }) => t.scheduledTaskId)).toEqual(
        [task.scheduledTaskId],
      );

      const updated = yield* json("update_scheduled_task", {
        scheduledTaskId: task.scheduledTaskId,
        prompt: "Post the time in Zurich.",
        schedule: { type: "interval", everyMs: 600_000 },
        enabled: false,
      });
      expect(updated.value).toMatchObject({
        scheduledTaskId: task.scheduledTaskId,
        prompt: "Post the time in Zurich.",
        schedule: { type: "interval", everyMs: 600_000 },
        enabled: false,
      });
      const lastSave = saves(cloud.requests).at(-1)!.input as {
        automationId: string;
        compiled: any;
      };
      expect(lastSave.automationId).toBe(task.scheduledTaskId);
      expect(lastSave.compiled.meta.triggers[0]).toEqual({ cron: "*/10 * * * *", timezone: "UTC" });
      expect(engine.automations.get(task.scheduledTaskId)!.summary.enabled).toBe(false);

      const notATask = yield* json("update_scheduled_task", {
        scheduledTaskId: changed.automationId,
        prompt: "x",
      });
      expect(notATask.isError).toBe(true);
      expect(notATask.text).toContain("automation_");

      const ran = yield* json("run_scheduled_task_now", { taskId: task.scheduledTaskId });
      expect(ran.value).toMatchObject({
        taskId: task.scheduledTaskId,
        threadId: THREAD,
        lastRunStatus: "running",
      });

      const deleted = yield* json("delete_scheduled_task", {
        scheduledTaskId: task.scheduledTaskId,
      });
      expect(deleted.value).toEqual({ scheduledTaskId: task.scheduledTaskId, deleted: true });
      expect(engine.automations.has(task.scheduledTaskId)).toBe(false);
      expect((yield* json("list_scheduled_tasks", {})).value.tasks).toEqual([]);
    }),
  );
});
