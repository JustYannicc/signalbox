import type { EnvironmentId, ModelSelection, ProjectId, ServerConfig } from "@t3tools/contracts";
import {
  resolveNewTaskInitialModelSelection,
  resolveNewTaskSelectedModelSelection,
} from "./new-task-model-selection-policy";
import { useProjectPoolModelSelection, type PoolHome } from "../sections/useProjectPool";

export { resolveNewTaskInitialModelSelection, resolveNewTaskSelectedModelSelection };

export function useNewTaskModelSelection(input: {
  readonly draftSelection: ModelSelection | null;
  readonly projectDefaultIsConfigured: boolean;
  readonly projectDefaultSelection: ModelSelection | null | undefined;
  readonly personDefaultSelection: ModelSelection | null | undefined;
  readonly settings: Parameters<typeof resolveNewTaskInitialModelSelection>[0]["settings"];
  readonly projectId: ProjectId | null;
  readonly environmentId: EnvironmentId | null;
  readonly config: ServerConfig | null;
  readonly home?: PoolHome;
}) {
  const initialSelection = resolveNewTaskInitialModelSelection(input);
  const poolSelection = useProjectPoolModelSelection({
    environmentId: input.environmentId,
    projectId: input.projectId,
    selection: initialSelection,
    providerInstances: input.settings.providerInstances,
    providers: input.config?.providers ?? [],
    home: input.home,
  });
  return resolveNewTaskSelectedModelSelection({
    draftSelection: input.draftSelection,
    initialSelection,
    poolSelection,
  });
}
