/**
 * Everything an automation can be built from: the steps the workflow SDK has
 * and the triggers that start a run, in the words of the SDK reference agents
 * read (the skill in apps/server/src/workflows/skill). One list for the canvas's
 * add-step palette and the Steps reference, so both say the same thing.
 */
import type { WorkflowStepVerb } from "@t3tools/contracts";
import { VERB_LABEL } from "@t3tools/client-runtime/automations/labels";
import {
  CalendarClockIcon,
  Columns3Icon,
  PlayIcon,
  RepeatIcon,
  WebhookIcon,
  ZapIcon,
  type LucideIcon,
} from "lucide-react";

import { verbIcon } from "./nodeVisuals";

export interface CatalogEntry {
  readonly id: string;
  readonly label: string;
  /** How it's written in the code, e.g. `w.agent`. */
  readonly code: string;
  readonly description: string;
  readonly icon: LucideIcon;
  readonly kind: "step" | "trigger";
}

export interface CatalogGroup {
  readonly title: string;
  readonly entries: ReadonlyArray<CatalogEntry>;
}

const step = (verb: WorkflowStepVerb, description: string): CatalogEntry => ({
  id: verb,
  label: VERB_LABEL[verb],
  code: `w.${verb}`,
  description,
  icon: verbIcon(verb),
  kind: "step",
});

const flow = (id: string, label: string, icon: LucideIcon, description: string) =>
  ({ id, label, code: `w.${id}`, description, icon, kind: "step" }) satisfies CatalogEntry;

const trigger = (id: string, label: string, code: string, icon: LucideIcon, description: string) =>
  ({ id, label, code, description, icon, kind: "trigger" }) satisfies CatalogEntry;

export const STEP_GROUPS: ReadonlyArray<CatalogGroup> = [
  {
    title: "Agents and models",
    entries: [
      step(
        "agent",
        "Hand real work to an agent thread you can open and steer, optionally in a fresh worktree.",
      ),
      step("llm", "Write or summarize text."),
      step("judge", "Make a decision between named outcomes, then branch on the answer."),
      step("extract", "Pull structured data out of text."),
    ],
  },
  {
    title: "You",
    entries: [
      step(
        "ask",
        "Ask you and wait for the answer: approve or reject, its own options, or a form to fill in.",
      ),
      step("notify", "Tell you something."),
    ],
  },
  {
    title: "Services and code",
    entries: [
      step("call", "Call a service you connected in Signalbox. Credentials stay on the server."),
      step("http", "Call any HTTP API."),
      step(
        "run",
        "Run a function from the automation's file in Node, with npm packages, for anything else.",
      ),
      step("start", "Start another automation."),
    ],
  },
  {
    title: "Waiting and memory",
    entries: [
      step("sleep", "Wait for a while, or until a time."),
      step("waitFor", "Wait for an outside event, with an optional timeout."),
      step("recall", "Read a value saved by an earlier run, like a cursor or handled ids."),
      step("remember", "Save a value for later runs."),
    ],
  },
  {
    title: "Flow",
    entries: [
      flow("each", "For each", RepeatIcon, "Run steps for each item, optionally several at once."),
      flow(
        "repeat",
        "Repeat",
        RepeatIcon,
        "Repeat steps until done or a maximum number of attempts. Good for review loops.",
      ),
      flow("parallel", "At the same time", Columns3Icon, "Run named branches at the same time."),
    ],
  },
];

export const TRIGGER_GROUP: CatalogGroup = {
  title: "Triggers",
  entries: [
    trigger(
      "cron",
      "On a schedule",
      "{ cron }",
      CalendarClockIcon,
      "Run on a cron schedule, in a timezone you choose.",
    ),
    trigger(
      "webhook",
      "When a webhook arrives",
      "{ webhook: true }",
      WebhookIcon,
      "Run for every POST to the automation's webhook URL, with its payload as input.",
    ),
    trigger(
      "event",
      "When something happens",
      '{ on: "turn.finished" }',
      ZapIcon,
      "Run when a turn finishes, a message is sent, an agent needs you, or any other event, in any harness.",
    ),
    trigger(
      "manual",
      "When you run it",
      "Run now",
      PlayIcon,
      "Every automation can be run by hand, with or without triggers.",
    ),
  ],
};

/** Groups with only the entries matching `query` in their label, code or description. */
export function filterCatalog(
  groups: ReadonlyArray<CatalogGroup>,
  query: string,
): ReadonlyArray<CatalogGroup> {
  const needle = query.trim().toLowerCase();
  if (!needle) return groups;
  return groups
    .map((group) => ({
      title: group.title,
      entries: group.entries.filter((entry) =>
        [entry.label, entry.code, entry.description].some((text) =>
          text.toLowerCase().includes(needle),
        ),
      ),
    }))
    .filter((group) => group.entries.length > 0);
}
