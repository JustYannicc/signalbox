import {
  automationEventSpec,
  type WorkflowEventTrigger,
  type WorkflowTrigger,
} from "@t3tools/contracts";

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

/** "When a turn finishes or an agent needs you, if status is failed": an event trigger in words. */
function describeEventTrigger(trigger: WorkflowEventTrigger): string {
  const patterns = typeof trigger.on === "string" ? [trigger.on] : trigger.on;
  const phrases = patterns.map((pattern, index) => {
    const phrase = eventPhrase(pattern, trigger.from);
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
