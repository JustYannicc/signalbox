import {
  MIN_SCHEDULED_TASK_INTERVAL_MS,
  ScheduledTaskSchedule,
  type WorkflowTrigger,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * Upstream's scheduled tasks (`schedule_task` and friends) as automations
 * (#367): one file per task, with a cron trigger and one step that wakes the
 * bound thread or starts an agent. The task itself rides in the file's second
 * line, so list and update read it back without a table of their own. A file
 * someone changed is theirs: it reads back as nothing, and stays a normal
 * automation. Webhook tasks aren't automations yet: cloud automations have no
 * webhook address.
 */

/** The schedules a task can keep as a cron. */
export type ScheduledTaskTimer = Exclude<ScheduledTaskSchedule, { readonly type: "webhook" }>;

export interface ScheduledTaskSpec {
  readonly title: string;
  readonly prompt: string;
  /** Intervals run at the cadence a cron keeps (`asRuns`). */
  readonly schedule: ScheduledTaskTimer;
  /** IANA zone the cron keeps for fixed times. */
  readonly timezone: string;
  /** The thread each run wakes, or null to start a new thread per run. */
  readonly threadId: string | null;
  /** What makes saving it twice save one automation: the agent's client request id. */
  readonly key: string | null;
}

const Spec = Schema.Struct({
  v: Schema.Literal(1),
  title: Schema.String,
  prompt: Schema.String,
  schedule: ScheduledTaskSchedule,
  timezone: Schema.String,
  threadId: Schema.NullOr(Schema.String),
  key: Schema.NullOr(Schema.String),
});
const decodeSpec = Schema.decodeUnknownOption(Schema.fromJsonString(Spec));

const MINUTE = 60_000;
/** Cadences, in minutes, a five-field cron keeps evenly: divisors of an hour and of a day, then a week. */
const CADENCES = [
  1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60, 120, 180, 240, 360, 480, 720, 1440, 10080,
];

const cadenceCron = (minutes: number) => {
  if (minutes === 1) return "* * * * *";
  if (minutes < 60) return `*/${minutes} * * * *`;
  if (minutes === 60) return "0 * * * *";
  if (minutes < 1440) return `0 */${minutes / 60} * * *`;
  return minutes === 1440 ? "0 0 * * *" : "0 0 * * 0";
};

/**
 * The cron for an interval. Crons keep the clock, not a stopwatch, so an
 * interval that doesn't divide an hour, a day or a week runs at the nearest
 * cadence that does (by ratio, the slower one on a tie); `everyMs` says which.
 */
export const intervalCron = (everyMs: number): { cron: string; everyMs: number } => {
  const minutes = Math.max(everyMs, MIN_SCHEDULED_TASK_INTERVAL_MS) / MINUTE;
  let best = CADENCES[0]!;
  for (const cadence of CADENCES) {
    const distance = Math.abs(Math.log(cadence / minutes));
    const bestDistance = Math.abs(Math.log(best / minutes));
    if (distance <= bestDistance + 1e-9) best = cadence;
    if (cadence > minutes) break;
  }
  return { cron: cadenceCron(best), everyMs: best * MINUTE };
};

/** The schedule as it will run. */
export const asRuns = (schedule: ScheduledTaskTimer): ScheduledTaskTimer =>
  schedule.type === "interval"
    ? { type: "interval", everyMs: intervalCron(schedule.everyMs).everyMs }
    : schedule;

/** The cron trigger that fires when the task would. */
export const scheduledTaskTrigger = (
  schedule: ScheduledTaskTimer,
  timezone: string,
): WorkflowTrigger => {
  if (schedule.type === "interval") return { cron: intervalCron(schedule.everyMs).cron, timezone };
  const [hour, minute] = schedule.timeOfDay.trim().split(":").map(Number);
  const days = [...new Set(schedule.weekdays ?? [])].toSorted((a, b) => a - b);
  const weekdays = days.length === 0 || days.length === 7 ? "*" : days.join(",");
  return { cron: `${minute} ${hour} * * ${weekdays}`, timezone };
};

/** Every scheduled task's `meta.description`, which tells tasks apart without reading every file. */
export const SCHEDULED_TASK_DESCRIPTION = "Runs a prompt an agent scheduled.";

const HEADER =
  "// Scheduled with schedule_task. Change anything and it's a normal automation schedule_task no longer manages.";
const SPEC_PREFIX = "// schedule_task: ";

/** JSON on one comment line: U+2028 and U+2029 would end the line. */
const commentJson = (value: unknown) =>
  JSON.stringify(value).replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");

/** The automation's file for a scheduled task. */
export const scheduledTaskSource = (task: ScheduledTaskSpec): string => {
  // The line is compared as written, so its keys keep one order.
  const spec = {
    v: 1 as const,
    title: task.title,
    prompt: task.prompt,
    schedule: asRuns(task.schedule),
    timezone: task.timezone,
    threadId: task.threadId,
    key: task.key,
  };
  const step =
    spec.threadId === null
      ? `await w.agent("Run the prompt", { prompt: PROMPT });`
      : `await w.call("Wake the thread", "signalbox.t3_thread_send", { threadId: ${JSON.stringify(spec.threadId)}, message: PROMPT, mode: "queue" });`;
  return [
    HEADER,
    `${SPEC_PREFIX}${commentJson(spec)}`,
    "export const meta = {",
    `  name: ${JSON.stringify(spec.title)},`,
    `  description: ${JSON.stringify(SCHEDULED_TASK_DESCRIPTION)},`,
    `  triggers: [${JSON.stringify(scheduledTaskTrigger(spec.schedule, spec.timezone))}],`,
    "} as const;",
    "",
    `const PROMPT = ${JSON.stringify(spec.prompt)};`,
    "",
    "export default workflow(async (w) => {",
    `  ${step}`,
    "});",
    "",
  ].join("\n");
};

/** The scheduled task an automation's file is, or null when it isn't one or someone changed it. */
export const readScheduledTask = (source: string): ScheduledTaskSpec | null => {
  const line = source.split("\n", 2)[1];
  if (line === undefined || !line.startsWith(SPEC_PREFIX)) return null;
  const decoded = decodeSpec(line.slice(SPEC_PREFIX.length));
  if (Option.isNone(decoded)) return null;
  const { title, prompt, schedule, timezone, threadId, key } = decoded.value;
  if (schedule.type === "webhook") return null;
  const task: ScheduledTaskSpec = { title, prompt, schedule, timezone, threadId, key };
  return scheduledTaskSource(task) === source ? task : null;
};
