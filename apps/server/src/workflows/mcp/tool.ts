import { OrchestratorMcpFailure } from "@t3tools/contracts";
import type * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as WorkflowEngine from "@signalbox/automations/WorkflowEngine";

/** How every automation tool is declared: its services, failure and annotations. */

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagement.ThreadManagementService,
  WorkflowEngine.WorkflowEngine,
  // automation_save picks a model for callers without a thread.
  ProjectService.ProjectService,
  ThreadLaunch.ThreadLaunchService,
];

export const tool = <
  Name extends string,
  P extends Schema.Struct.Fields = {},
  S extends Schema.Top = Schema.Top,
>(
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
