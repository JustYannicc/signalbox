import type { AutomationBuiltIn } from "@t3tools/contracts";

import { MERGE_GATE } from "./mergeGate.ts";
import { SETTLE_TASK } from "./settleTask.ts";
import { TASK_DONE } from "./taskDone.ts";
import { PAYMENT } from "./payment.ts";
import { WAIT_FOR } from "./waitFor.ts";
import { WATCH_PULL_REQUEST } from "./watchPullRequest.ts";
import { HARNESS_RELEASE_WATCH } from "./harnessRelease.ts";

/**
 * Built-in automations: defaults Signalbox ships in code, so behaviour that
 * would otherwise be special-case server code is an automation anyone can
 * read, run, attach to a thread and customize. They're resolved by name:
 * a project's own automation with the same name wins, which is what
 * Customize makes.
 *
 * To run in a project a built-in needs a host row there (runs, steps and
 * models are per project). That row is marked with the built-in's slug, is
 * re-saved from this code whenever the code changes, and refuses edits, so
 * the code here stays the only source. Customize clears the mark, which
 * makes the row an ordinary automation the project owns.
 */

export interface BuiltInAutomation {
  readonly slug: string;
  /** Its `meta.name`; a test holds the source to it. */
  readonly name: string;
  readonly description: string;
  readonly source: string;
  /** Domain events that install this default in the thread's folder before delivery. */
  readonly defaultOn?: ReadonlyArray<string>;
}

export const BUILT_IN_AUTOMATIONS: ReadonlyArray<BuiltInAutomation> = [
  {
    slug: "task-done",
    name: "Task done",
    description:
      "Proposes an editable done-condition and archives the task with an outcome when it holds.",
    source: TASK_DONE,
    defaultOn: ["thread.created", "thread.pull-request-link-updated", "run.updated"],
  },
  {
    slug: "settle-task",
    name: "Settle task",
    description:
      "Records why a task was settled early, finishes work that is done enough, and asks quietly when the reason is unclear.",
    source: SETTLE_TASK,
    defaultOn: ["thread.settled"],
  },
  {
    slug: "watch-pull-request",
    name: "Watch pull request",
    description:
      "Watches a thread's pull request, wakes its agent when checks fail or pass, someone else comments or reviews, or the branch conflicts, and stops when it merges or closes. Run it attached to the thread; watch_pull_request does.",
    source: WATCH_PULL_REQUEST,
  },
  {
    slug: "wait-for",
    name: "Wait for",
    description:
      "Waits for one thing for a thread's agent (an event, a call to a callback link, or a time), then tells the agent once what happened. The wait_for tool runs it attached to the caller's thread.",
    source: WAIT_FOR,
  },
  {
    slug: "merge-gate",
    name: "Merge gate",
    description:
      "Decides whether a thread's pull request merges: by default it sends an unready one back to the agent, merges a ready one that's easy to undo by itself, and asks you first when it's hard to undo or undecided. merge_pull_request runs it; customize it to change who or what decides.",
    source: MERGE_GATE,
  },
  {
    slug: "payment",
    name: "Payment",
    description:
      "Hands a payment an agent's browser reached to you: by default you finish it in the agent's live browser and answer Done or Failed, and the agent carries on. needs_you_payment runs it; customize it to change who or what decides.",
    source: PAYMENT,
  },
  {
    slug: "harness-release-watch",
    name: "Watch harness releases",
    description:
      "Checks current Claude Code, Claude Agent SDK and Codex releases, then works through a bounded historical set. Run builtin:harness-release-watch once with the Signalbox project's ID to install its hourly trigger in that project.",
    source: HARNESS_RELEASE_WATCH,
  },
];

const ID_PREFIX = "builtin:";

/** The id agents use for a built-in before it runs anywhere: `builtin:<slug>`. */
export const builtInId = (builtIn: BuiltInAutomation) => `${ID_PREFIX}${builtIn.slug}`;

export const builtInById = (id: string) =>
  id.startsWith(ID_PREFIX) ? BUILT_IN_AUTOMATIONS.find((b) => builtInId(b) === id) : undefined;

/** A built-in by its `meta.name`, for `w.start` and runs by name. */
export const builtInByName = (name: string) => BUILT_IN_AUTOMATIONS.find((b) => b.name === name);

/** The built-in a row hosts, when it's a host row. */
export const builtInOfRow = (row: { readonly builtin_slug?: string | null }) =>
  row.builtin_slug ? BUILT_IN_AUTOMATIONS.find((b) => b.slug === row.builtin_slug) : undefined;

export const builtInSummary = (builtIn: BuiltInAutomation): AutomationBuiltIn => ({
  id: builtInId(builtIn),
  name: builtIn.name,
  description: builtIn.description,
});
