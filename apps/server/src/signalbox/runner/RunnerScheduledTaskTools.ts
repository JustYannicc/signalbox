import {
  asRuns,
  readScheduledTask,
  SCHEDULED_TASK_DESCRIPTION,
  type ScheduledTaskSpec,
  type ScheduledTaskTimer,
} from "@signalbox/automations/scheduledTasks";
import { AUTOMATION_TOOLS } from "@signalbox/automations/tools/declarations";
import {
  OrchestratorMcpDeleteScheduledTaskInput,
  OrchestratorMcpListScheduledTasksInput,
  OrchestratorMcpScheduleTaskInput,
  OrchestratorMcpUpdateScheduledTaskInput,
  ProjectId,
  ScheduledTaskId,
  ThreadId,
  TrimmedNonEmptyString,
  type AutomationRunStatus,
  type OrchestratorMcpScheduledTask,
  type ScheduledTaskRunStatus,
  type ScheduledTaskUpsertSchedule,
} from "@t3tools/contracts";
import { scheduledTaskSource } from "@signalbox/automations/scheduledTasks";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { answer, automationCaller, saveCompiled } from "./RunnerAutomationTools.ts";
import { fail, register, ToolError } from "./RunnerContextTools.ts";
import type { DrivesView } from "./RunnerDrivesView.ts";

/**
 * Upstream's scheduled-task tools (`schedule_task` and friends) for a cloud
 * thread's agent (#367). There is no scheduler in the cloud: each task is an
 * automation in the thread's folder on the cloud's engine, with a cron
 * trigger and one step that wakes this thread or starts an agent, written by
 * `@signalbox/automations/scheduledTasks`. The cron fires from the user's
 * object, so runs happen with every client closed. A task's id is its
 * automation's, and a task someone edits becomes a plain automation.
 */

export const RUNNER_SCHEDULED_TASK_TOOLS = [
  "schedule_task",
  "list_scheduled_tasks",
  "update_scheduled_task",
  "delete_scheduled_task",
  "run_scheduled_task_now",
] as const;

const Timezone = Schema.optional(
  TrimmedNonEmptyString.annotate({
    description:
      "IANA timezone a fixed_time schedule keeps, such as Europe/Zurich. Defaults to UTC; pass the user's zone when you know it.",
  }),
);

const ScheduleTaskInput = Schema.Struct({
  ...OrchestratorMcpScheduleTaskInput.fields,
  timezone: Timezone,
});
const UpdateTaskInput = Schema.Struct({
  ...OrchestratorMcpUpdateScheduledTaskInput.fields,
  timezone: Timezone,
});
const RunNowInput = Schema.Struct({ taskId: ScheduledTaskId });

const decodeList = Schema.decodeUnknownEffect(AUTOMATION_TOOLS.automation_list.success);
const decodeRead = Schema.decodeUnknownEffect(AUTOMATION_TOOLS.automation_read.success);
const decodeSave = Schema.decodeUnknownEffect(AUTOMATION_TOOLS.automation_save.success);
const decodeRun = Schema.decodeUnknownEffect(AUTOMATION_TOOLS.automation_run.success);
const decodeSetEnabled = Schema.decodeUnknownEffect(
  AUTOMATION_TOOLS.automation_set_enabled.success,
);

type Summary = (typeof AUTOMATION_TOOLS.automation_list.success.Type)["automations"][number];

const unexpected = () =>
  new ToolError({ message: "Signalbox's cloud answered something this machine doesn't read." });

/** The schedule a task keeps, or why it can't run here. */
const runnable = (schedule: ScheduledTaskUpsertSchedule) =>
  schedule.type === "webhook"
    ? fail(
        "Webhook tasks don't run in the cloud yet: cloud automations have no webhook address. Schedule a time instead, or save an automation with an event trigger (automation_save).",
      )
    : Effect.succeed<ScheduledTaskTimer>(schedule);

/** The zone's canonical IANA name. */
const knownZone = (timezone: string) =>
  Option.match(DateTime.zoneMakeNamed(timezone), {
    onNone: () => fail(`${timezone} isn't a timezone; pass an IANA name like Europe/Zurich.`),
    onSome: (zone) => Effect.succeed(zone.id),
  });

/** Upstream's run statuses: a cancelled run didn't succeed. */
const runStatus = (status: AutomationRunStatus): ScheduledTaskRunStatus =>
  status === "cancelled" ? "failed" : status;

/** A task as upstream's tools answer it, plus the automation it is and its zone. */
const taskView = (
  summary: Summary,
  task: ScheduledTaskSpec,
): OrchestratorMcpScheduledTask & { readonly automationId: string; readonly timezone: string } => ({
  scheduledTaskId: ScheduledTaskId.make(summary.automationId),
  automationId: summary.automationId,
  title: summary.name,
  prompt: task.prompt,
  enabled: summary.enabled,
  projectId: ProjectId.make(summary.projectId),
  boundThreadId: task.threadId === null ? null : ThreadId.make(task.threadId),
  schedule: asRuns(task.schedule),
  timezone: task.timezone,
  nextRunAt: summary.nextRunAt,
  lastRunStatus: summary.lastRun === null ? "never" : runStatus(summary.lastRun.status),
});

/** Upstream's default title: the prompt's first line. */
const titleOf = (prompt: string) => prompt.split("\n")[0]?.trim().slice(0, 80) || "Scheduled task";

/** The first of `title`, `title (2)`, … no other automation in `automations` is named. */
const freeName = (automations: ReadonlyArray<Summary>, title: string, own: string | null) => {
  const taken = new Set(
    automations
      .filter((automation) => automation.automationId !== own)
      .map((automation) => automation.name),
  );
  let name = title;
  for (let n = 2; taken.has(name); n += 1) name = `${title} (${n})`;
  return name;
};

/** Whether `name` is `title` or one `freeName` made from it. */
const namedFrom = (name: string, title: string) =>
  name === title ||
  (name.startsWith(`${title} (`) && /^\(\d+\)$/.test(name.slice(title.length + 1)));

export const layerScheduledTaskTools = (view: DrivesView, threadId: string | null) => {
  const ask = automationCaller(view);

  const read = (automationId: string) =>
    ask("automation_read", { automationId }, true).pipe(
      Effect.flatMap((result) => decodeRead(result).pipe(Effect.mapError(unexpected))),
    );
  const list = ask("automation_list", {}, true).pipe(
    Effect.flatMap((result) => decodeList(result).pipe(Effect.mapError(unexpected))),
    Effect.map(({ automations }) => automations),
  );
  /** Those of `automations` that are still tasks as they were scheduled. */
  const tasksAmong = (automations: ReadonlyArray<Summary>) =>
    Effect.forEach(
      automations.filter((automation) => automation.description === SCHEDULED_TASK_DESCRIPTION),
      (automation) =>
        read(automation.automationId).pipe(
          Effect.map(({ automation: summary, source }) => {
            const task = readScheduledTask(source);
            return task === null ? [] : [{ summary, task }];
          }),
        ),
      { concurrency: 4 },
    ).pipe(Effect.map((found) => found.flat()));
  /** A task by id, or why that automation isn't one this tool may change. */
  const task = (automationId: string) =>
    read(automationId).pipe(
      Effect.flatMap(({ automation: summary, source, draft }) => {
        const found = readScheduledTask(source);
        if (found === null)
          return fail(
            `${automationId} isn't a scheduled task: someone changed its file, or it never was one, so it's a normal automation. Change it with automation_read and automation_save.`,
          );
        // Saving live would drop the draft someone saved for review.
        if (draft !== null)
          return fail(
            `${automationId} has a draft waiting to be published. Publish or discard it in Automations (automation_publish, automation_discard_draft) first.`,
          );
        return Effect.succeed({ summary, task: found });
      }),
    );

  /** Writes the task's file through the cloud, compiled here. */
  const save = (
    spec: ScheduledTaskSpec,
    place: { readonly projectId?: string; readonly automationId?: string },
  ) =>
    saveCompiled(ask, { source: scheduledTaskSource(spec), ...place }).pipe(
      Effect.flatMap((result) => decodeSave(result).pipe(Effect.mapError(unexpected))),
      Effect.flatMap((saved) =>
        saved.ok
          ? Effect.succeed(saved.automation)
          : fail(
              `The task's automation didn't compile: ${saved.diagnostics.map((d) => d.message).join("; ")}`,
            ),
      ),
    );

  const setEnabled = (summary: Summary, enabled: boolean | undefined) =>
    enabled === undefined || enabled === summary.enabled
      ? Effect.succeed(summary)
      : ask("automation_set_enabled", { automationId: summary.automationId, enabled }, false).pipe(
          Effect.flatMap((result) => decodeSetEnabled(result).pipe(Effect.mapError(unexpected))),
          Effect.map(({ automation }) => automation),
        );

  /** The thread a task wakes: this one when it binds, none when it doesn't. */
  const boundTo = (bind: boolean | undefined, current: string | null) => {
    if (bind === undefined) return Effect.succeed(current);
    if (!bind) return Effect.succeed(null);
    return threadId === null
      ? fail("This machine doesn't know its thread, so a task can't wake it.")
      : Effect.succeed(threadId);
  };

  return Layer.effectDiscard(
    Effect.all([
      register({
        name: "schedule_task",
        description:
          "Schedule a prompt to run on its own, as an automation in this thread's folder: people see and change it in Automations, and it runs in the cloud with every client closed. interval and fixed_time schedules run as a cron, so an interval runs at the nearest cadence that divides an hour, a day or a week (the result says which). By default each run posts the prompt into this thread (bindToCurrentThread=true); false starts a fresh thread per run. Pass schedule as a structured object: {type:'interval', everyMs:300000} is every 5 minutes; {type:'fixed_time', timeOfDay:'09:00', weekdays:[1,2,3,4,5]} with timezone is weekday mornings. Webhook schedules don't run in the cloud yet. Report the returned schedule and nextRunAt; stop it with delete_scheduled_task, or pause it with update_scheduled_task enabled=false.",
        parameters: ScheduleTaskInput,
        writes: { destructive: false, openWorld: false },
        handle: (input) =>
          Effect.gen(function* () {
            const schedule = yield* runnable(input.schedule);
            const timezone = yield* knownZone(input.timezone ?? "UTC");
            const title = input.title ?? titleOf(input.prompt);
            const automations = yield* list;
            const key =
              input.clientRequestId === undefined
                ? null
                : threadId === null
                  ? input.clientRequestId
                  : `${threadId}:${input.clientRequestId}`;
            if (key !== null) {
              // A retry saved under this title, or one freeName made from it.
              const candidates = automations.filter((automation) =>
                namedFrom(automation.name, title),
              );
              const retried = (yield* tasksAmong(candidates)).find(
                (found) => found.task.key === key,
              );
              if (retried)
                return answer(
                  taskView(yield* setEnabled(retried.summary, input.enabled), retried.task),
                );
            }
            const spec: ScheduledTaskSpec = {
              title: freeName(automations, title, null),
              prompt: input.prompt,
              schedule,
              timezone,
              threadId: yield* boundTo(input.bindToCurrentThread ?? true, null),
              key,
            };
            const saved = yield* save(
              spec,
              input.projectId === undefined ? {} : { projectId: input.projectId },
            );
            return answer(taskView(yield* setEnabled(saved, input.enabled), spec));
          }),
      }),
      register({
        name: "list_scheduled_tasks",
        description:
          "The tasks schedule_task made that are still as scheduled, each an automation (scheduledTaskId is its automation id). Ones someone changed are normal automations: see automation_list.",
        parameters: OrchestratorMcpListScheduledTasksInput,
        handle: (input) =>
          list.pipe(
            Effect.map((automations) =>
              automations.filter(
                (automation) =>
                  input.projectId === undefined || automation.projectId === input.projectId,
              ),
            ),
            Effect.flatMap(tasksAmong),
            Effect.map((found) =>
              answer({ tasks: found.map(({ summary, task }) => taskView(summary, task)) }),
            ),
          ),
      }),
      register({
        name: "update_scheduled_task",
        description:
          "Change a scheduled task by scheduledTaskId (from schedule_task or list_scheduled_tasks). Only the provided fields change. enabled=false pauses it without deleting it.",
        parameters: UpdateTaskInput,
        writes: { destructive: false, openWorld: false },
        handle: (input) =>
          Effect.gen(function* () {
            const current = yield* task(input.scheduledTaskId);
            const own = current.summary.automationId;
            const spec: ScheduledTaskSpec = {
              ...current.task,
              title:
                input.title === undefined
                  ? current.task.title
                  : freeName(yield* list, input.title, own),
              prompt: input.prompt ?? current.task.prompt,
              schedule:
                input.schedule === undefined
                  ? current.task.schedule
                  : yield* runnable(input.schedule),
              timezone:
                input.timezone === undefined
                  ? current.task.timezone
                  : yield* knownZone(input.timezone),
              threadId: yield* boundTo(input.bindToCurrentThread, current.task.threadId),
            };
            const saved =
              scheduledTaskSource(spec) === scheduledTaskSource(current.task)
                ? current.summary
                : yield* save(spec, { automationId: own });
            return answer(taskView(yield* setEnabled(saved, input.enabled), spec));
          }),
      }),
      register({
        name: "delete_scheduled_task",
        description:
          "Delete a scheduled task by scheduledTaskId, and its automation with it. It stops running at once; update_scheduled_task enabled=false pauses it instead.",
        parameters: OrchestratorMcpDeleteScheduledTaskInput,
        writes: { destructive: true, openWorld: false },
        handle: (input) =>
          Effect.gen(function* () {
            yield* task(input.scheduledTaskId);
            yield* ask("automation_delete", { automationId: input.scheduledTaskId }, false);
            return answer({ scheduledTaskId: input.scheduledTaskId, deleted: true });
          }),
      }),
      register({
        name: "run_scheduled_task_now",
        description:
          "Run a scheduled task now, outside its schedule. Each call starts a new run of its automation.",
        parameters: RunNowInput,
        writes: { destructive: false, openWorld: false },
        handle: (input) =>
          Effect.gen(function* () {
            const current = yield* task(input.taskId);
            const { run } = yield* ask(
              "automation_run",
              { automationId: input.taskId },
              false,
            ).pipe(Effect.flatMap((result) => decodeRun(result).pipe(Effect.mapError(unexpected))));
            return answer({
              taskId: input.taskId,
              threadId: current.task.threadId,
              runId: run.runId,
              lastRunStatus: runStatus(run.status),
              nextRunAt: current.summary.nextRunAt,
            });
          }),
      }),
    ]),
  );
};
