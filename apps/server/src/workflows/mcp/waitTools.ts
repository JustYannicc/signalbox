import { WorkflowDuration, WorkflowSourceWatch } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { tool } from "./tool.ts";

/** Agent tools for waiting on something; handlers.ts runs them through the engine's waits. */

const WaitId = Schema.String.annotate({
  description: "The wait's id, from wait_for or list_waits.",
});

export const WaitForTool = tool("wait_for", {
  title: "Wait for something",
  description:
    'Wait for something to happen, then end your turn: Signalbox wakes this thread with one message saying what happened. Use it instead of polling, sleeping or running a watcher. Meanwhile the thread stays in the user\'s Working list. Give `until` and exactly one of: `on` (+ `where`) for any Signalbox event, with the same names and matching as automation event triggers, e.g. on: "pr.checks.failed", where: { number: 12 }; on: "turn.finished", where: { threadId } to wait for another thread or a delegated task; on: "automation.run.succeeded", where: { automationRunId }; `watch` for a change in anything a connection reads, e.g. watch: { operation: "stripe.invoices.list", key: "id" } with an optional `condition` in words that each change is judged against ("its status is paid"), and `on` to narrow it to source.item.added, source.item.changed or source.item.removed; Signalbox reads the source every few minutes for everyone watching it; `callback: true` for a link to hand to someone else (a payment provider, a form, a person): a request to it wakes you with its body; or `at` for a time ("check back tomorrow"). `timeout` ends the wait early and wakes you saying nothing happened. The wait ends when it fires, on stop_waiting, or when the thread is settled, archived or stopped. For a pull request you own, watch_pull_request keeps watching through every check and review instead of waking once.',
  parameters: Schema.Struct({
    until: Schema.String.annotate({
      description:
        'What you\'re waiting for, read after "Waiting for" in the thread: "checks on #12 to finish", "the invoice to be paid".',
    }),
    on: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])).annotate({
      description: "Event names or patterns (pr.*); see the automation triggers reference.",
    }),
    where: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)).annotate({
      description:
        "Top-level event fields that must equal these values (or one of an array's). Narrow it, or any matching event in the project wakes you.",
    }),
    watch: Schema.optional(WorkflowSourceWatch).annotate({
      description:
        "Something a connection lists (an Executor operation, as w.call names it), watched for changes by `key`.",
    }),
    condition: Schema.optional(Schema.String).annotate({
      description:
        "With watch: what a change has to show, in words. Without it, any change wakes you.",
    }),
    callback: Schema.optional(Schema.Boolean),
    at: Schema.optional(Schema.String).annotate({ description: "An ISO time to wake at." }),
    timeout: Schema.optional(WorkflowDuration),
    message: Schema.optional(Schema.String).annotate({
      description: "What you want to be told when you wake, e.g. the next step of your task.",
    }),
  }),
  success: Schema.Struct({
    waitId: WaitId,
    callbackUrl: Schema.NullOr(Schema.String).annotate({
      description:
        "With callback: true, the link to hand out. A path when the server has no public address yet.",
    }),
  }),
  readonly: false,
});

export const ListWaitsTool = tool("list_waits", {
  title: "List waits",
  description:
    "What this thread is waiting on: every wait_for and pull request watch, and anything else attached to it that keeps it in Working.",
  success: Schema.Struct({
    waits: Schema.Array(
      Schema.Struct({
        waitId: WaitId,
        automation: Schema.String,
        label: Schema.String.annotate({ description: "What the thread shows for it." }),
        startedAt: Schema.String,
      }),
    ),
  }),
  readonly: true,
});

export const StopWaitingTool = tool("stop_waiting", {
  title: "Stop waiting",
  description: "End one of this thread's waits. Nothing wakes you for it after this.",
  parameters: Schema.Struct({ waitId: WaitId }),
  success: Schema.Struct({ stopped: Schema.Boolean }),
  readonly: false,
});

export const MergePullRequestTool = tool("merge_pull_request", {
  title: "Merge pull request",
  description:
    "Ask to merge a pull request you own, then end your turn. The folder's merge gate decides: by default a person approves it as a needs-you, then Signalbox merges it, deletes its branch and wakes you with the outcome; if they say not yet, you're told why. Call it once checks pass and the work is done, and never merge any other way (no gh pr merge). The pull request has to be linked to this thread and still open.",
  parameters: Schema.Struct({
    url: Schema.String.annotate({ description: "The pull request's URL." }),
    note: Schema.optional(Schema.String).annotate({
      description: "What the person deciding should know: what changed and how you checked it.",
    }),
  }),
  success: Schema.Struct({
    waitId: WaitId,
    alreadyRequested: Schema.Boolean.annotate({
      description: "A merge request for it was already waiting; this one changed nothing.",
    }),
  }),
  readonly: false,
});
