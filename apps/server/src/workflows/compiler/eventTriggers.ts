import {
  AUTOMATION_EVENTS,
  AUTOMATION_RAW_EVENT_PREFIX,
  automationEventMatches,
  isAutomationEventPattern,
  SOURCE_ITEM_EVENTS,
} from "@t3tools/contracts";

import { durationMs } from "../stepPolicy.ts";
import { isSourceWatch, MIN_EVERY_MS } from "../sources/watch.ts";

/**
 * Checks `{ on: … }` triggers before the schema does, so a typo gets the
 * closest event names instead of a union mismatch.
 */

export interface TriggerProblem {
  readonly message: string;
  readonly hint: string;
}

const NAMES: ReadonlyArray<string> = AUTOMATION_EVENTS.map((spec) => spec.name);
const PATTERN_HINT = `Events: ${NAMES.join(", ")}. Wildcards like "turn.*" or "*" match several; "${AUTOMATION_RAW_EVENT_PREFIX}<type>" is any raw orchestration event.`;

function distance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    let diagonal = previous[0]!;
    previous[0] = i;
    for (let j = 1; j <= right.length; j++) {
      const above = previous[j]!;
      previous[j] = Math.min(
        above + 1,
        previous[j - 1]! + 1,
        diagonal + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return previous[right.length]!;
}

/** Up to three catalog names closest to `name`, best first. */
function closestEventNames(name: string): ReadonlyArray<string> {
  const target = name.replace(/\.\*$/, "");
  return NAMES.map((candidate) => ({
    candidate,
    score: Math.min(
      distance(target, candidate),
      candidate.startsWith(target) || candidate.includes(target) ? 1 : Infinity,
    ),
  }))
    .filter((entry) => entry.score <= Math.max(2, Math.floor(target.length / 3)))
    .toSorted((left, right) => left.score - right.score)
    .slice(0, 3)
    .map((entry) => entry.candidate);
}

const OPERATION = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_$-]+)+$/;

const WATCH_EXAMPLE =
  '{ on: "source.item.added", watch: { operation: "github.actions.listWorkflowRunsForRepo", args: { owner, repo }, key: "id" } }';

/** What's wrong with a `watch` and the `on` it comes with, or null. `on` is only checked when known. */
export function sourceWatchProblem(watch: unknown, on: unknown): TriggerProblem | null {
  if (!isSourceWatch(watch))
    return {
      message: "`watch` needs an `operation` and the `key` that identifies an item.",
      hint: WATCH_EXAMPLE,
    };
  if (!OPERATION.test(watch.operation))
    return {
      message: `"${watch.operation}" isn't an operation name; use the one w.call takes, like "stripe.invoices.list".`,
      hint: WATCH_EXAMPLE,
    };
  const every = watch.every === undefined ? null : durationMs(watch.every);
  if (every !== null && every < MIN_EVERY_MS)
    return {
      message: "A source is checked at most once a minute.",
      hint: "every: { minutes: 1 } or more.",
    };
  const patterns = typeof on === "string" ? [on] : Array.isArray(on) ? on : null;
  const sourceEvent = (pattern: unknown) =>
    typeof pattern === "string" &&
    SOURCE_ITEM_EVENTS.some((name) => automationEventMatches(pattern.trim(), name));
  if (patterns !== null && !patterns.every(sourceEvent))
    return {
      message: "`watch` goes with source.item.* events, which say what changed in it.",
      hint: WATCH_EXAMPLE,
    };
  return null;
}

/** The first problem with the literal `triggers` array's event triggers, or null. */
export function eventTriggerProblem(
  triggers: unknown,
  /** A `w.waitFor` with a `watch` beside its `on`, checked on its own. */
  options: { readonly watched?: boolean } = {},
): TriggerProblem | null {
  if (!Array.isArray(triggers)) return null;
  for (const trigger of triggers) {
    if (!trigger || typeof trigger !== "object" || !("on" in trigger)) continue;
    if ("cron" in trigger || "webhook" in trigger) {
      return {
        message: "A trigger is a cron, a webhook or an event (`on`), not several at once.",
        hint: 'Split it: triggers: [{ cron: "0 9 * * *" }, { on: "turn.finished" }]',
      };
    }
    const on = (trigger as { readonly on: unknown }).on;
    const patterns = typeof on === "string" ? [on] : Array.isArray(on) ? on : null;
    if (patterns === null || patterns.length === 0 || patterns.some((p) => typeof p !== "string")) {
      return {
        message: "`on` takes an event name or a list of them.",
        hint: 'e.g. { on: "turn.finished" } or { on: ["message.sent", "thread.created"] }',
      };
    }
    if ("watch" in trigger) {
      const problem = sourceWatchProblem((trigger as { readonly watch: unknown }).watch, on);
      if (problem) return { ...problem, message: `meta.triggers: ${problem.message}` };
    } else if (
      !options.watched &&
      (patterns as ReadonlyArray<unknown>).some(
        (pattern) => typeof pattern === "string" && pattern.trim().startsWith("source."),
      )
    ) {
      return {
        message: "source.item.* events need a `watch` saying which source.",
        hint: WATCH_EXAMPLE,
      };
    }
    for (const pattern of patterns as ReadonlyArray<string>) {
      if (isAutomationEventPattern(pattern.trim())) continue;
      const close = closestEventNames(pattern.trim());
      return {
        message: `meta.triggers listens for an unknown event "${pattern}".${
          close.length > 0 ? ` Did you mean ${close.map((name) => `"${name}"`).join(" or ")}?` : ""
        }`,
        hint: PATTERN_HINT,
      };
    }
  }
  return null;
}

/** What's wrong with a \`w.waitFor\` \`on\`, checked at compile time when literal and at run time when computed. */
export function waitForEventProblem(on: unknown, watched = false): TriggerProblem | null {
  const problem = eventTriggerProblem([{ on }], { watched });
  return (
    problem && {
      ...problem,
      message: problem.message.replace("meta.triggers listens for", "w.waitFor waits for"),
    }
  );
}
