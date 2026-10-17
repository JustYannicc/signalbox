import {
  AutomationRetryVersion,
  AutomationRunAttach,
  ProjectId,
  SecretRef,
  WorkflowDuration,
  WorkflowSourceWatch,
} from "@t3tools/contracts";
import { TaskLifecycleInput, TaskLifecycleResult } from "@t3tools/contracts/taskLifecycle";
import * as Schema from "effect/Schema";

import { BuiltInList } from "./builtIns.ts";
import {
  AutomationSummary,
  ReadResult,
  RunReadResult,
  RunSummary,
  SaveResult,
  ValidateResult,
} from "./summaries.ts";

/**
 * What every host's automation tools are: names, descriptions, inputs and
 * results, without how a host answers them. The self-hosted server declares
 * its MCP tools from these (`apps/server/src/workflows/mcp/tools.ts`), and a
 * cloud thread's machine serves the same ones (`RunnerAutomationTools.ts`).
 */

export interface AutomationToolDeclaration<P extends Schema.Struct.Fields, S extends Schema.Top> {
  readonly title: string;
  readonly description: string;
  /** Absent for a tool without inputs. */
  readonly parameters?: Schema.Struct<P>;
  readonly success: S;
  readonly readonly: boolean;
  readonly destructive?: boolean;
}

/** Keeps each declaration's exact type, so hosts read its input's fields. */
const declare = <D extends AutomationToolDeclaration<Schema.Struct.Fields, Schema.Top>>(
  declaration: D,
) => declaration;

const AutomationId = Schema.String.annotate({
  description: "The automation's id, from automation_list or automation_save.",
});
const RunId = Schema.String.annotate({
  description: "The run's id, from automation_run or automation_read.",
});
const Source = Schema.String.annotate({
  description:
    "The full TypeScript file. Read automation_reference before writing one if you haven't yet.",
});

const WaitId = Schema.String.annotate({
  description: "The wait's id, from wait_for or list_waits.",
});

/** MCP calls are scoped to the calling thread by default. */
const TaskLifecycleToolInput = Schema.Struct({
  ...TaskLifecycleInput.fields,
  threadId: Schema.optional(
    TaskLifecycleInput.fields.threadId.annotate({
      description: "Thread to act on. Omit to use the calling thread.",
    }),
  ),
});

/** Every automation tool, by its MCP name. */
export const AUTOMATION_TOOLS = {
  task_lifecycle: declare({
    title: "Task lifecycle",
    description:
      "Read or change this task's completion condition and state. `propose` stores an editable completion condition with its executable JSON input; use `read` to inspect the current condition and settlement outcome. `complete` is for the completion automation when its condition holds. `reopen` restores an archived or settled task. `record-settle` records a human settlement reason. Omit threadId for this thread. Agents may read tasks in the same project; changes act only on their calling thread.",
    parameters: TaskLifecycleToolInput,
    success: TaskLifecycleResult,
    readonly: false,
  }),
  automation_reference: declare({
    title: "Automation reference",
    description:
      "The signalbox-automations skill, for harnesses that don't load skills: how to write, save, run and fix an automation. Read it before writing or changing one. No topic returns the main page; topics: steps, control-flow, triggers, runs, patterns, or an example file name such as work-through-tickets.",
    parameters: Schema.Struct({
      topic: Schema.optional(Schema.String).annotate({
        description: "steps, control-flow, triggers, runs, patterns, or an example's file name.",
      }),
    }),
    success: Schema.Struct({ reference: Schema.String }),
    readonly: true,
  }),
  automation_validate: declare({
    title: "Check an automation",
    description:
      "Compile an automation without saving it. Returns the diagram as an outline, or the errors to fix with line numbers and hints.",
    parameters: Schema.Struct({ source: Source }),
    success: ValidateResult,
    readonly: true,
  }),
  automation_save: declare({
    title: "Save automation",
    description:
      "Save an automation in projectId, else the calling thread's project; callers outside a Signalbox thread must pass projectId. It goes live immediately: cron and webhook triggers start firing. With draft: true it's saved without going live: the automation keeps running its live version (a new one stays off) until the user or automation_publish publishes the draft; prefer a draft when changing an automation people rely on and the user hasn't asked for the change to go live. Saving live replaces any pending draft. Its agent steps use the calling thread's provider and model (the project's default model without a thread) and your modes, unless the code names others. Saving a file whose meta.name matches an automation in that project saves a new version of it; runs already going keep their version. Updating an automation that runs with more access than you have is refused. Compile errors come back as diagnostics instead of saving.",
    parameters: Schema.Struct({
      source: Source,
      projectId: Schema.optional(
        ProjectId.annotate({
          description:
            "The project to save it in, from t3_project_list. Defaults to the calling thread's project; required outside a Signalbox thread.",
        }),
      ),
      automationId: Schema.optional(
        AutomationId.annotate({ description: "Update this automation even if the name changed." }),
      ),
      draft: Schema.optional(
        Schema.Boolean.annotate({ description: "Save as a draft instead of going live." }),
      ),
    }),
    success: SaveResult,
    readonly: false,
  }),
  automation_list: declare({
    title: "List automations",
    description:
      "Every automation with its project, whether it's on, its triggers, next run, and last run, plus the built-in automations Signalbox ships.",
    success: Schema.Struct({ automations: Schema.Array(AutomationSummary), builtIns: BuiltInList }),
    readonly: true,
  }),
  automation_read: declare({
    title: "Read automation",
    description:
      "An automation's live source, its diagram as an outline, the user's original request (intent), its pending draft if any, and its recent runs. Built-ins read by their `builtin:<slug>` id too.",
    parameters: Schema.Struct({ automationId: AutomationId }),
    success: ReadResult,
    readonly: true,
  }),
  automation_run: declare({
    title: "Run automation",
    description:
      "Start a run now, even while the automation is turned off. `input` is passed to the workflow as its second argument. With `attach`, the run is bound to a thread: the thread stays in Working while it runs, settling, archiving or stopping the thread cancels it, and a second run with the same key returns the running one. A `builtin:<slug>` id runs the project's customized copy if there is one, else the built-in, in the attached thread's project, else projectId, else yours. Refused when the automation runs with more access than you have.",
    parameters: Schema.Struct({
      automationId: AutomationId,
      input: Schema.optional(Schema.Unknown),
      attach: Schema.optional(AutomationRunAttach),
      projectId: Schema.optional(
        ProjectId.annotate({ description: "Where a built-in runs when it isn't attached." }),
      ),
    }),
    success: Schema.Struct({ run: RunSummary }),
    readonly: false,
  }),
  automation_run_read: declare({
    title: "Read automation run",
    description:
      "A run's status, each step with its status, attempt, result, error (with why and fix when known) and agent thread, the diagram outline with step statuses, the output, and the code's newest console lines. Steps waiting on the user show status waiting with verb ask; only the user can answer them, in Signalbox.",
    parameters: Schema.Struct({ runId: RunId }),
    success: RunReadResult,
    readonly: true,
  }),
  automation_set_enabled: declare({
    title: "Turn automation on or off",
    description: "Pause or resume an automation's triggers. Runs already going continue.",
    parameters: Schema.Struct({ automationId: AutomationId, enabled: Schema.Boolean }),
    success: Schema.Struct({ automation: AutomationSummary }),
    readonly: false,
  }),
  automation_cancel_run: declare({
    title: "Cancel automation run",
    description:
      "Stop a run: its agents, requests and processes stop, and runs it started with w.start are cancelled too. Agent threads keep their history.",
    parameters: Schema.Struct({ runId: RunId }),
    success: Schema.Struct({}),
    readonly: false,
    destructive: true,
  }),
  automation_run_retry: declare({
    title: "Retry automation run",
    description:
      'Retry a failed or cancelled run as a new run. Steps that succeeded are reused while the code reaches them the same way (same call site, verb and label); the failed step and everything after it run again. version: "same" (default) replays the run\'s own version; "latest" uses the live version, e.g. after saving a fix. Refused when the automation runs with more access than you have.',
    parameters: Schema.Struct({
      runId: RunId,
      version: Schema.optional(AutomationRetryVersion),
    }),
    success: Schema.Struct({ run: RunSummary }),
    readonly: false,
  }),
  automation_publish: declare({
    title: "Publish automation draft",
    description:
      "Make an automation's pending draft its live version. Triggers and new runs use it from now on; runs already going keep their version. A never-published automation turns on.",
    parameters: Schema.Struct({ automationId: AutomationId }),
    success: Schema.Struct({ automation: AutomationSummary }),
    readonly: false,
  }),
  automation_discard_draft: declare({
    title: "Discard automation draft",
    description: "Drop an automation's pending draft. The live version stays as it is.",
    parameters: Schema.Struct({ automationId: AutomationId }),
    success: Schema.Struct({ automation: AutomationSummary }),
    readonly: false,
    destructive: true,
  }),
  automation_delete: declare({
    title: "Delete automation",
    description:
      "Delete an automation with its versions, runs and memory. Only when the user asked for it.",
    parameters: Schema.Struct({ automationId: AutomationId }),
    success: Schema.Struct({}),
    readonly: false,
    destructive: true,
  }),
  automation_emit: declare({
    title: "Send automation event",
    description:
      "Deliver an event to every run waiting on it with w.waitFor. Returns how many runs it woke.",
    parameters: Schema.Struct({ event: Schema.String, payload: Schema.optional(Schema.Unknown) }),
    success: Schema.Struct({ woke: Schema.Int }),
    readonly: false,
  }),
  automation_set_webhook_secret: declare({
    title: "Set automation webhook secret",
    description:
      "Set the signing secret a webhook trigger's `signature` checks requests against. Ask the user for it with request_secret and pass the secretRef you get back; you never see the value, and it is never shown again. Until it's set, signed webhooks turn every request away. Rotating the URL keeps it.",
    parameters: Schema.Struct({
      automationId: AutomationId,
      secretRef: SecretRef.annotate({ description: "From request_secret; it works once." }),
    }),
    success: Schema.Struct({ automation: AutomationSummary }),
    readonly: false,
  }),
  automation_customize: declare({
    title: "Customize built-in automation",
    description:
      "Make a built-in automation the project's own (projectId, default: your thread's project): its row there stops being built in, or a copy is saved under its name if it never ran there. From then on that project runs its own version wherever the built-in was used; change it with automation_save.",
    parameters: Schema.Struct({
      automationId: AutomationId.annotate({
        description: "The built-in's `builtin:<slug>` id, or the id of its row in a project.",
      }),
      projectId: Schema.optional(ProjectId),
    }),
    success: Schema.Struct({ automation: AutomationSummary }),
    readonly: false,
  }),
  wait_for: declare({
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
  }),
  list_waits: declare({
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
  }),
  stop_waiting: declare({
    title: "Stop waiting",
    description: "End one of this thread's waits. Nothing wakes you for it after this.",
    parameters: Schema.Struct({ waitId: WaitId }),
    success: Schema.Struct({ stopped: Schema.Boolean }),
    readonly: false,
  }),
  merge_pull_request: declare({
    title: "Merge pull request",
    description:
      "Ask to merge a pull request you own, then end your turn. The folder's merge gate decides and wakes you with the outcome. By default it reads the pull request's evidence at its head commit: if checks failed or still run, review threads are open, changes were requested, it's a draft or it conflicts, you're told what to fix and nothing reaches a person. When it's ready and easy to undo, Signalbox merges it and deletes its branch. A change that's hard to undo (a migration, sign-in or access control, deleting data) or that you say needs a decision goes to a person with the evidence first. Call it when the work is done and checked, and never merge any other way (no gh pr merge). The pull request has to be linked to this thread and still open.",
    parameters: Schema.Struct({
      url: Schema.String.annotate({ description: "The pull request's URL." }),
      note: Schema.optional(Schema.String).annotate({
        description:
          "What a person deciding should know: what changed, how you checked it, the preview you walked.",
      }),
      askBecause: Schema.optional(Schema.String).annotate({
        description:
          "Only when a person should decide this one, why: a product question the issue leaves open, or a change that's hard to undo the gate wouldn't spot (it deletes or rewrites data). The gate asks instead of merging.",
      }),
    }),
    success: Schema.Struct({
      waitId: WaitId,
      alreadyRequested: Schema.Boolean.annotate({
        description: "A merge request for it was already waiting; this one changed nothing.",
      }),
    }),
    readonly: false,
  }),
};
