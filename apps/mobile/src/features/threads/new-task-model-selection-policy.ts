import {
  DEFAULT_SERVER_SETTINGS,
  resolveProjectProviderInstanceEnabled,
  type ModelSelection,
  type ProjectId,
  type ServerConfig,
} from "@t3tools/contracts";
import {
  resolveProjectSettings,
  type LegacyProjectSettingsFields,
} from "@t3tools/shared/projectSettings";
import { resolveInitialModelSelection } from "@t3tools/shared/defaultModelSelection";
import { resolveSelectableModelSelection } from "../../lib/modelOptions";

export function resolveScheduledTaskDefaultModelSelection(
  config: ServerConfig | null,
  project: (LegacyProjectSettingsFields & { readonly id: ProjectId }) | null,
): ModelSelection | null {
  const settings = config?.settings ?? DEFAULT_SERVER_SETTINGS;
  const resolvedProjectSettings = resolveProjectSettings(settings, project?.id ?? null, project);
  const selectableConfig = config
    ? {
        ...config,
        providers: config.providers.filter(
          (provider) => (provider.models[0]?.slug ?? "").length > 0,
        ),
      }
    : null;
  return resolveNewTaskInitialModelSelection({
    projectDefaultIsConfigured: resolvedProjectSettings.sources.defaultModelSelection === "project",
    projectDefaultSelection: resolvedProjectSettings.settings.defaultModelSelection,
    personDefaultSelection: settings.defaultModelSelection,
    settings: resolvedProjectSettings.settings,
    projectId: project?.id ?? null,
    config: selectableConfig,
  });
}

export function resolveNewTaskInitialModelSelection(input: {
  readonly projectDefaultIsConfigured: boolean;
  readonly projectDefaultSelection: ModelSelection | null | undefined;
  readonly personDefaultSelection: ModelSelection | null | undefined;
  readonly settings: Parameters<typeof resolveProjectProviderInstanceEnabled>[0];
  readonly projectId: ProjectId | null;
  readonly config: ServerConfig | null;
}): ModelSelection | null {
  const projectDefault = input.projectDefaultIsConfigured
    ? (input.projectDefaultSelection ?? null)
    : null;
  const personDefault =
    input.personDefaultSelection &&
    resolveProjectProviderInstanceEnabled(
      input.settings,
      input.projectId,
      input.personDefaultSelection.instanceId,
    )
      ? input.personDefaultSelection
      : null;
  const providers = (input.config?.providers ?? []).filter((provider) => {
    const model = provider.models[0]?.slug;
    return (
      provider.availability !== "unavailable" &&
      model !== undefined &&
      resolveSelectableModelSelection(
        input.config,
        { instanceId: provider.instanceId, model },
        input.projectId,
      ) !== null
    );
  });
  return resolveInitialModelSelection({
    projectDefault,
    personDefault,
    providers,
  });
}

export function resolveNewTaskSelectedModelSelection(input: {
  readonly draftSelection: ModelSelection | null;
  readonly initialSelection: ModelSelection | null;
  readonly poolSelection: ModelSelection | null;
}): {
  readonly projectDefaultModelSelection: ModelSelection | null;
  readonly selectedModelSelection: ModelSelection | null;
} {
  const projectDefaultModelSelection = input.poolSelection ?? input.initialSelection;
  return {
    projectDefaultModelSelection,
    selectedModelSelection: input.draftSelection ?? projectDefaultModelSelection,
  };
}
