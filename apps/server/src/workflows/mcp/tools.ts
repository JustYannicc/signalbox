import { AutomationRetryVersion, OrchestratorMcpFailure, ProjectId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as WorkflowEngine from "../WorkflowEngine.ts";
import {
  AutomationSummary,
  ReadResult,
  RunReadResult,
  RunSummary,
  SaveResult,
  ValidateResult,
} from "./summaries.ts";

/**
 * Agent tools for automations. Each handler calls one engine method (see
 * handlers.ts); what they return is in summaries.ts.
 */

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagement.ThreadManagementService,
  WorkflowEngine.WorkflowEngine,
  // automation_save picks a model for callers without a thread.
  ProjectService.ProjectService,
  ServerSettings.ServerSettingsService,
];

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

const tool = <Name extends string, P extends Schema.Struct.Fields, S extends Schema.Top>(
  name: Name,
  options: {
    title: string;
    description: string;
    parameters?: Schema.Struct<P>;
    success: S;
    readonly: boolean;
    destructive?: boolean;
  },
) =>
  Tool.make(name, {
    description: options.description,
    // Tools without inputs leave parameters out, which publishes an empty object schema.
    ...(options.parameters ? { parameters: options.parameters } : {}),
    success: options.success,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies,
  })
    .annotate(Tool.Title, options.title)
    .annotate(Tool.Readonly, options.readonly)
    .annotate(Tool.Destructive, options.destructive ?? false)
    .annotate(Tool.OpenWorld, false);

export const AutomationReferenceTool = tool("automation_reference", {
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
});

export const AutomationValidateTool = tool("automation_validate", {
  title: "Check an automation",
  description:
    "Compile an automation without saving it. Returns the diagram as an outline, or the errors to fix with line numbers and hints.",
  parameters: Schema.Struct({ source: Source }),
  success: ValidateResult,
  readonly: true,
});

export const AutomationSaveTool = tool("automation_save", {
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
});

export const AutomationListTool = tool("automation_list", {
  title: "List automations",
  description:
    "Every automation with its project, whether it's on, its triggers, next run, and last run.",
  success: Schema.Struct({ automations: Schema.Array(AutomationSummary) }),
  readonly: true,
});

export const AutomationReadTool = tool("automation_read", {
  title: "Read automation",
  description:
    "An automation's live source, its diagram as an outline, the user's original request (intent), its pending draft if any, and its recent runs.",
  parameters: Schema.Struct({ automationId: AutomationId }),
  success: ReadResult,
  readonly: true,
});

export const AutomationRunTool = tool("automation_run", {
  title: "Run automation",
  description:
    "Start a run now, even while the automation is turned off. `input` is passed to the workflow as its second argument. Refused when the automation runs with more access than you have.",
  parameters: Schema.Struct({ automationId: AutomationId, input: Schema.optional(Schema.Unknown) }),
  success: Schema.Struct({ run: RunSummary }),
  readonly: false,
});

export const AutomationRunReadTool = tool("automation_run_read", {
  title: "Read automation run",
  description:
    "A run's status, each step with its status, attempt, result, error (with why and fix when known) and agent thread, the diagram outline with step statuses, the output, and the code's newest console lines. Steps waiting on the user show status waiting with verb ask; only the user can answer them, in Signalbox.",
  parameters: Schema.Struct({ runId: RunId }),
  success: RunReadResult,
  readonly: true,
});

export const AutomationSetEnabledTool = tool("automation_set_enabled", {
  title: "Turn automation on or off",
  description: "Pause or resume an automation's triggers. Runs already going continue.",
  parameters: Schema.Struct({ automationId: AutomationId, enabled: Schema.Boolean }),
  success: Schema.Struct({ automation: AutomationSummary }),
  readonly: false,
});

export const AutomationCancelRunTool = tool("automation_cancel_run", {
  title: "Cancel automation run",
  description:
    "Stop a run: its agents, requests and processes stop, and runs it started with w.start are cancelled too. Agent threads keep their history.",
  parameters: Schema.Struct({ runId: RunId }),
  success: Schema.Struct({}),
  readonly: false,
  destructive: true,
});

export const AutomationRunRetryTool = tool("automation_run_retry", {
  title: "Retry automation run",
  description:
    'Retry a failed or cancelled run as a new run. Steps that succeeded are reused while the code reaches them the same way (same call site, verb and label); the failed step and everything after it run again. version: "same" (default) replays the run\'s own version; "latest" uses the live version, e.g. after saving a fix. Refused when the automation runs with more access than you have.',
  parameters: Schema.Struct({
    runId: RunId,
    version: Schema.optional(AutomationRetryVersion),
  }),
  success: Schema.Struct({ run: RunSummary }),
  readonly: false,
});

export const AutomationPublishTool = tool("automation_publish", {
  title: "Publish automation draft",
  description:
    "Make an automation's pending draft its live version. Triggers and new runs use it from now on; runs already going keep their version. A never-published automation turns on.",
  parameters: Schema.Struct({ automationId: AutomationId }),
  success: Schema.Struct({ automation: AutomationSummary }),
  readonly: false,
});

export const AutomationDiscardDraftTool = tool("automation_discard_draft", {
  title: "Discard automation draft",
  description: "Drop an automation's pending draft. The live version stays as it is.",
  parameters: Schema.Struct({ automationId: AutomationId }),
  success: Schema.Struct({ automation: AutomationSummary }),
  readonly: false,
  destructive: true,
});

export const AutomationDeleteTool = tool("automation_delete", {
  title: "Delete automation",
  description:
    "Delete an automation with its versions, runs and memory. Only when the user asked for it.",
  parameters: Schema.Struct({ automationId: AutomationId }),
  success: Schema.Struct({}),
  readonly: false,
  destructive: true,
});

export const AutomationEmitTool = tool("automation_emit", {
  title: "Send automation event",
  description:
    "Deliver an event to every run waiting on it with w.waitFor. Returns how many runs it woke.",
  parameters: Schema.Struct({ event: Schema.String, payload: Schema.optional(Schema.Unknown) }),
  success: Schema.Struct({ woke: Schema.Int }),
  readonly: false,
});

export const AutomationToolkit = Toolkit.make(
  AutomationReferenceTool,
  AutomationValidateTool,
  AutomationSaveTool,
  AutomationListTool,
  AutomationReadTool,
  AutomationRunTool,
  AutomationRunReadTool,
  AutomationSetEnabledTool,
  AutomationCancelRunTool,
  AutomationRunRetryTool,
  AutomationPublishTool,
  AutomationDiscardDraftTool,
  AutomationDeleteTool,
  AutomationEmitTool,
);
