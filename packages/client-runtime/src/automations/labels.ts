import type {
  AutomationRunTrigger,
  AutomationStep,
  WorkflowStepNode,
  WorkflowStepVerb,
} from "@t3tools/contracts";
import { ellipsize } from "@t3tools/shared/String";

import type { LayoutContainer } from "./layout.ts";
import { serviceIdentity } from "./services.ts";

/** The words every client uses for steps, loops and what started a run. */

export const VERB_LABEL: Record<WorkflowStepVerb, string> = {
  agent: "Agent",
  llm: "Write",
  judge: "Decide",
  extract: "Extract",
  ask: "Ask you",
  call: "Call",
  http: "Web request",
  run: "Run code",
  notify: "Notify you",
  sleep: "Wait",
  waitFor: "Wait for event",
  recall: "Recall",
  remember: "Remember",
  start: "Start automation",
};

/** "Agent · Claude", "Web request · api.github.com", "Ask you". */
export function stepTypeLabel(node: Pick<WorkflowStepNode, "verb" | "service">): string {
  const identity = serviceIdentity(node.service);
  return identity ? `${VERB_LABEL[node.verb]} · ${identity.name}` : VERB_LABEL[node.verb];
}

/** What started a run. Also an untitled finished run's title, so it reads as one. */
export const RUN_TRIGGER_LABEL: Record<AutomationRunTrigger, string> = {
  manual: "Run by hand",
  cron: "On schedule",
  webhook: "From webhook",
  automation: "Started by an automation",
  event: "From an event",
};

/** What a loop, parallel group or try block is, when its own label doesn't say. */
export const CONTAINER_TYPE_LABEL: Record<LayoutContainer["kind"], string> = {
  each: "For each",
  repeat: "Repeat",
  for: "Loop",
  while: "Loop",
  parallel: "At the same time",
  try: "If something fails",
};

/** How long a finished step or run took; null while it's still going. */
export function durationMs(entry: {
  readonly startedAt: string;
  readonly finishedAt: string | null;
}): number | null {
  if (!entry.finishedAt) return null;
  const ms = Date.parse(entry.finishedAt) - Date.parse(entry.startedAt);
  return Number.isFinite(ms) ? ms : null;
}

/** Steps that run in an agent thread a person can open. */
const THREAD_VERBS: ReadonlySet<WorkflowStepVerb> = new Set(["agent", "llm", "judge", "extract"]);

/** The agent thread that did a step's work, when there is one to open. */
export function agentThreadId(step: Pick<AutomationStep, "verb" | "threadId">): string | null {
  return step.threadId && THREAD_VERBS.has(step.verb) ? step.threadId : null;
}

/** Pretty JSON, strings as they are, cut short so a huge value can't stall a screen. */
export function compactJson(value: unknown, maxLength = 2_000): string {
  if (value === undefined) return "undefined";
  let text: string;
  try {
    text = typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? String(value));
  } catch {
    text = String(value);
  }
  return ellipsize(text.trim(), maxLength);
}

/** "3 earlier passes not shown": what a list cut to its newest entries leaves out. */
export function hiddenPassesLabel(hidden: number): string {
  return `${hidden} earlier ${hidden === 1 ? "pass" : "passes"} not shown`;
}
