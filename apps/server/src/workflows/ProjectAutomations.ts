import {
  type AutomationDefaults,
  type AutomationError,
  type AutomationSaveInput,
  type AutomationSaveResult,
  type ModelSelection,
  type ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { AuthorizeAutomation } from "@signalbox/automations/catalog";
import { needsDefaultModel } from "@signalbox/automations/defaultModels";
import { automationError, fail } from "@signalbox/automations/errors";
import { AutomationCompiler } from "@signalbox/automations/host";
import * as WorkflowEngine from "@signalbox/automations/WorkflowEngine";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProjectService from "../project/ProjectService.ts";

export type SaveInput<E = never> = Omit<AutomationSaveInput, "defaults"> & {
  readonly callerModelSelection?: ModelSelection | undefined;
  readonly runtimeMode: AutomationDefaults["runtimeMode"];
  readonly interactionMode: AutomationDefaults["interactionMode"];
  readonly authorize?: AuthorizeAutomation<E> | undefined;
};

export class ProjectAutomations extends Context.Service<
  ProjectAutomations,
  {
    readonly save: <E = never>(
      input: SaveInput<E>,
    ) => Effect.Effect<AutomationSaveResult, AutomationError | E>;
  }
>()("t3/workflows/ProjectAutomations") {}

const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const compiler = yield* AutomationCompiler;
  const engine = yield* WorkflowEngine.WorkflowEngine;

  const requireProject = (projectId: ProjectId) =>
    projects.getById(projectId).pipe(
      Effect.mapError((cause) => automationError(`Couldn't read project ${projectId}.`, { cause })),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            fail(`Project ${projectId} doesn't exist. t3_project_list lists the projects.`),
          onSome: Effect.succeed,
        }),
      ),
    );

  const save = <E = never>(input: SaveInput<E>) =>
    Effect.gen(function* () {
      const project = yield* requireProject(input.projectId);
      const compiled = input.automationId === undefined ? compiler.compile(input.source) : null;
      const editingByName =
        input.automationId === undefined &&
        compiled?.ok === true &&
        (yield* engine.list()).some(
          (automation) =>
            automation.projectId === input.projectId &&
            automation.name === compiled.workflow.meta.name,
        );
      const editing = input.automationId !== undefined || editingByName;
      let modelSelection: ModelSelection | null = null;
      if (!editing && compiled?.ok === true && needsDefaultModel(compiled.workflow.graph.nodes)) {
        modelSelection =
          input.callerModelSelection ??
          (yield* launches
            .initialModelSelection(project.id)
            .pipe(
              Effect.mapError((cause) =>
                automationError("Couldn't read the default model.", { cause }),
              ),
            ));
        if (modelSelection === null) {
          return yield* fail("Choose a default model for this folder or person.");
        }
      }
      const defaults: AutomationDefaults = {
        modelSelection,
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
      };
      return yield* engine.save(
        {
          source: input.source,
          projectId: input.projectId,
          ...(input.automationId === undefined ? {} : { automationId: input.automationId }),
          ...(input.draft === undefined ? {} : { draft: input.draft }),
          defaults,
        },
        input.authorize,
      );
    });

  return ProjectAutomations.of({ save });
});

export const layer = Layer.effect(ProjectAutomations, make);
