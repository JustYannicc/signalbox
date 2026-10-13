import {
  DEFAULT_RUNTIME_MODE,
  OrchestratorMcpFailure,
  type AutomationDefaults,
  type ModelSelection,
  type ProjectId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { resolveRuntimeMode } from "../mcp/OrchestratorMcpService.ts";
import type { Caller, CallerLimits } from "../mcp/threadAccess.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { getAutoBootstrapThreadModelSelection } from "../serverRuntimeStartup.ts";
import type { AuthorizeAutomation } from "./catalog.ts";
import { automationError, fail } from "./errors.ts";
import * as WorkflowEngine from "./WorkflowEngine.ts";

/**
 * Automations saved, run or retried for an MCP caller: an agent's thread, or
 * an outside client signed in with OAuth that has no thread. Every call stands
 * alone; the caller comes from the request. Nothing may borrow more access
 * than its caller has, so a limited thread can't use a full-access automation
 * as a proxy.
 */

/** Pass as `authorize`: allows only automations that run within the caller's runtime mode. */
export const withinLimits =
  (limits: CallerLimits): AuthorizeAutomation<OrchestratorMcpFailure> =>
  (current) =>
    resolveRuntimeMode(limits.runtimeMode, current.runtimeMode).pipe(Effect.asVoid);

const requireProject = (projectId: ProjectId) =>
  ProjectService.ProjectService.use((projects) => projects.getById(projectId)).pipe(
    Effect.mapError((cause) => automationError(`Couldn't read project ${projectId}.`, { cause })),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          fail(`Project ${projectId} doesn't exist. t3_project_list lists the projects.`),
        onSome: Effect.succeed,
      }),
    ),
  );

/** What a new thread in the project would run: its default, else the environment's, else the built-in one. */
const defaultModelSelection = Effect.fn("workflows.defaultModelSelection")(function* (
  project: Effect.Success<ReturnType<typeof requireProject>>,
) {
  const settings = yield* ServerSettings.ServerSettingsService.use(
    (service) => service.getSettings,
  ).pipe(
    Effect.mapError((cause) => automationError("Couldn't read the server settings.", { cause })),
  );
  return (
    resolveProjectSettings(settings, project.id, project).settings.defaultModelSelection ??
    getAutoBootstrapThreadModelSelection()
  );
});

/**
 * What a person's own action in a client acts with: the project's default
 * model and full access, since nobody's access is being borrowed.
 */
export const projectDefaults = Effect.fn("workflows.projectDefaults")(function* (
  projectId: ProjectId,
) {
  const project = yield* requireProject(projectId);
  return {
    modelSelection: yield* defaultModelSelection(project),
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: "default",
  } satisfies AutomationDefaults;
});

/**
 * The defaults a caller's automations act with: its thread's model (the
 * project's default without a thread) and its modes.
 */
export const callerDefaults = Effect.fn("workflows.callerDefaults")(function* (
  { caller, limits }: Pick<Caller, "caller" | "limits">,
  projectId: ProjectId,
) {
  const modelSelection =
    caller?.modelSelection ?? (yield* defaultModelSelection(yield* requireProject(projectId)));
  return {
    modelSelection,
    runtimeMode: limits.runtimeMode,
    interactionMode: limits.interactionMode,
  } satisfies AutomationDefaults;
});

/**
 * Saves an automation. It goes in `projectId`, else the calling thread's
 * project; a caller without a thread has to name one. Agent steps default to
 * the calling thread's model, else the project's default, and run with the
 * caller's modes, which for an outside client is its runtime-mode ceiling.
 * A thread may save into another project: it already needs a live run to
 * save, and its own model and modes go with it.
 */
export const saveForCaller = Effect.fn("workflows.saveForCaller")(function* (
  { caller, limits }: Pick<Caller, "caller" | "limits">,
  input: {
    readonly source: string;
    readonly projectId?: ProjectId | undefined;
    readonly automationId?: string | undefined;
    readonly draft?: boolean | undefined;
  },
) {
  const named =
    input.projectId !== undefined && input.projectId !== caller?.projectId
      ? yield* requireProject(input.projectId)
      : undefined;
  let target: { readonly projectId: ProjectId; readonly modelSelection: ModelSelection };
  if (caller !== undefined) {
    target = { projectId: named?.id ?? caller.projectId, modelSelection: caller.modelSelection };
  } else if (named !== undefined) {
    target = { projectId: named.id, modelSelection: yield* defaultModelSelection(named) };
  } else {
    return yield* new OrchestratorMcpFailure({
      code: "target_required",
      message:
        "Pass projectId: you're not calling from a Signalbox thread, so there's no project to save the automation in. t3_project_list lists the projects.",
    });
  }
  const engine = yield* WorkflowEngine.WorkflowEngine;
  return yield* engine.save(
    {
      source: input.source,
      ...(input.automationId ? { automationId: input.automationId } : {}),
      ...(input.draft ? { draft: input.draft } : {}),
      projectId: target.projectId,
      defaults: {
        modelSelection: target.modelSelection,
        runtimeMode: limits.runtimeMode,
        interactionMode: limits.interactionMode,
      },
    },
    withinLimits(limits),
  );
});
