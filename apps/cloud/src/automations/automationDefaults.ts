import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type AutomationError,
  type AutomationDefaults,
  type ModelSelection,
  type ProjectId,
  type WorkflowGraph,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { needsDefaultModel } from "@signalbox/automations/defaultModels";
import type { WorkflowEngineShape } from "@signalbox/automations/WorkflowEngine";

/** Keeps an existing automation's defaults and captures a model only when new code inherits one. */
export const defaultsForSave = (input: {
  readonly engine: WorkflowEngineShape;
  readonly projectId: ProjectId;
  readonly automationId?: string;
  readonly name: string;
  readonly graph: WorkflowGraph;
  readonly newThreadModel: (projectId?: ProjectId) => Effect.Effect<ModelSelection | null>;
}): Effect.Effect<AutomationDefaults, AutomationError> =>
  Effect.gen(function* () {
    const automations = yield* input.engine.list();
    const editing = automations.some((automation) =>
      input.automationId
        ? automation.id === input.automationId
        : automation.projectId === input.projectId && automation.name === input.name,
    );
    const modelSelection =
      editing || !needsDefaultModel(input.graph.nodes)
        ? null
        : yield* input.newThreadModel(input.projectId);
    return {
      modelSelection,
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    };
  });
