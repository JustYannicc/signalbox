import {
  automationEventSpec,
  type AutomationSourceStatus,
  type WorkflowEventTrigger,
  type WorkflowTrigger,
} from "@t3tools/contracts";

import { serviceIdentity } from "./services.ts";

/** What starts an automation, in words: "Every hour", "Weekdays at 9:00", "When a turn finishes". */

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const FROM_PHRASES: Record<string, Record<NonNullable<WorkflowEventTrigger["from"]>, string>> = {
  "message.sent": {
    people: "When you send a message",
    agents: "When an agent sends a message",
    anyone: "When a message is sent",
  },
  "thread.created": {
    people: "When you start a thread",
    agents: "When an agent starts a thread",
    anyone: "When a thread starts",
  },
};

function eventPhrase(pattern: string, from: WorkflowEventTrigger["from"]): string {
  const byFrom = FROM_PHRASES[pattern];
  if (byFrom) return byFrom[from ?? "people"];
  if (pattern === "*") return "When anything happens";

  if (pattern.endsWith(".*")) return `When anything ${pattern.slice(0, -2)} happens`;
  return automationEventSpec(pattern)?.when ?? `On ${pattern}`;
}

const SOURCE_PHRASES: Record<string, (subject: string) => string> = {
  "source.item.added": (subject) => `When something new shows up in ${subject}`,
  "source.item.changed": (subject) => `When something in ${subject} changes`,
  "source.item.removed": (subject) => `When something leaves ${subject}`,
};

/** A source trigger's phrase, naming what it watches. */
function sourcePhrase(pattern: string, subject: string): string {
  return SOURCE_PHRASES[pattern]?.(subject) ?? `When anything changes in ${subject}`;
}

/**
 * A watched source in words, from the operation it reads:
 * `github.actions.listWorkflowRunsForRepo` → "Github workflow runs for repo".
 */
function describeSource(operation: string): string {
  const [service = "", ...rest] = operation.split(".");
  const name = serviceIdentity(service)?.name ?? service;
  const words = (rest.at(-1) ?? "")
    .replace(/^(list|get|search|fetch)(?=[A-Z_])/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words ? `${name} ${words}` : name;
}

/** "2m", "3h", "just now": how far `iso` is from `nowMs`, either way. */
function roughly(iso: string, nowMs: number): string {
  const minutes = Math.round(Math.abs(nowMs - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

/**
 * A watched source's status in parts: `subject` is what's read ("Github
 * workflow runs for repo (work)"), `status` how reading it goes ("checked 2m
 * ago"). Clients lay them out.
 */
export function watchedSource(
  source: AutomationSourceStatus,
  nowMs: number,
): { readonly subject: string; readonly status: string; readonly trouble: boolean } {
  const ago = (iso: string) => (roughly(iso, nowMs) ? `${roughly(iso, nowMs)} ago` : "just now");
  const retry =
    source.nextCheckAt && roughly(source.nextCheckAt, nowMs)
      ? `trying again in ${roughly(source.nextCheckAt, nowMs)}`
      : "trying again soon";
  const status =
    source.status === "watching" && source.lastCheckedAt
      ? `checked ${ago(source.lastCheckedAt)}`
      : source.status === "failing"
        ? `couldn't read it, ${retry}`
        : source.status === "paused"
          ? "stopped after failing again and again"
          : "first check soon";
  const account = source.connection ? ` (${source.connection})` : "";
  return {
    subject: `${describeSource(source.operation)}${account}`,
    status,
    trouble: source.status === "failing" || source.status === "paused",
  };
}

/** "When a turn finishes or an agent needs you, if status is failed": an event trigger in words. */
function describeEventTrigger(trigger: WorkflowEventTrigger): string {
  const patterns = typeof trigger.on === "string" ? [trigger.on] : trigger.on;
  const phrases = patterns.map((pattern, index) => {
    const phrase = trigger.watch
      ? sourcePhrase(pattern, describeSource(trigger.watch.operation))
      : eventPhrase(pattern, trigger.from);
    return index === 0 ? phrase : phrase.replace(/^When /, "").replace(/^On /, "on ");
  });
  const where = Object.entries(trigger.where ?? {}).map(
    ([field, value]) =>
      `${field} is ${Array.isArray(value) ? value.map(String).join(" or ") : String(value)}`,
  );
  return [
    phrases.join(" or "),
    trigger.scope === "all" ? " in any project" : "",
    where.length > 0 ? `, if ${where.join(" and ")}` : "",
  ].join("");
}

/** One trigger in words; uncommon crons stay crons. */
export function describeTrigger(trigger: WorkflowTrigger): string {
  if ("on" in trigger) return describeEventTrigger(trigger);
  if (!("cron" in trigger)) return "When a webhook arrives";
  const fields = trigger.cron.trim().split(/\s+/);
  if (fields.length !== 5) return trigger.cron;
  const [minute, hour, day, month, weekday] = fields as [string, string, string, string, string];
  const time =
    /^\d+$/.test(minute) && /^\d+$/.test(hour) ? `${hour}:${minute.padStart(2, "0")}` : null;
  if (month !== "*") return `Cron ${trigger.cron}`;
  if (/^\*\/(\d+)$/.test(minute) && hour === "*" && day === "*" && weekday === "*")
    return `Every ${minute.slice(2)} minutes`;
  if (/^\d+$/.test(minute) && hour === "*" && day === "*" && weekday === "*")
    return minute === "0" ? "Every hour" : `Every hour at :${minute.padStart(2, "0")}`;
  if (time && day === "*" && weekday === "*") return `Every day at ${time}`;
  if (time && day === "*" && (weekday === "1-5" || weekday === "MON-FRI"))
    return `Weekdays at ${time}`;
  if (time && day === "*" && /^\d$/.test(weekday))
    return `${WEEKDAYS[Number(weekday) % 7]}s at ${time}`;
  if (time && /^\d+$/.test(day) && weekday === "*") return `Monthly on the ${day} at ${time}`;
  return `Cron ${trigger.cron}`;
}

/** The trigger card's text: every trigger, or "When you run it". */
export function triggerSummary(triggers: ReadonlyArray<WorkflowTrigger>): string {
  return triggers.length === 0 ? "When you run it" : triggers.map(describeTrigger).join(" · ");
}

/** Only webhooks or events start it: a run needs a payload, so replaying one beats running empty. */
export function startsFromPayloadOnly(automation: {
  readonly triggers: ReadonlyArray<WorkflowTrigger>;
}): boolean {
  return (
    automation.triggers.length > 0 &&
    automation.triggers.every((trigger) => "webhook" in trigger || "on" in trigger)
  );
}
