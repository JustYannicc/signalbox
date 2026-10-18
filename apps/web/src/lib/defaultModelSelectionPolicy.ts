import {
  resolveProjectProviderInstanceEnabled,
  type ModelSelection,
  type ProjectId,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import {
  resolveProjectSettings,
  type LegacyProjectSettingsFields,
} from "@t3tools/shared/projectSettings";
import { resolveInitialModelSelection } from "@t3tools/shared/defaultModelSelection";
import type { ProviderInstanceEntry } from "../providerInstances";

export function resolveScheduledTaskDefaultModelSelection(
  settings: ServerSettings,
  project: (LegacyProjectSettingsFields & { readonly id: ProjectId }) | null,
  entries: ReadonlyArray<ProviderInstanceEntry>,
): ModelSelection | null {
  const resolvedProjectSettings = resolveProjectSettings(settings, project?.id ?? null, project);
  const personDefaultModelSelection = settings.defaultModelSelection;
  const projectProviderSettings =
    project?.id === undefined
      ? undefined
      : settings.projectSettingsOverrides[project.id]?.providerInstances;
  const personDefaultHasExplicitProviderSettings =
    personDefaultModelSelection !== null &&
    (Object.hasOwn(settings.providerInstances, personDefaultModelSelection.instanceId) ||
      Object.hasOwn(projectProviderSettings ?? {}, personDefaultModelSelection.instanceId));

  return resolveInitialModelSelection({
    projectDefault:
      resolvedProjectSettings.sources.defaultModelSelection === "project"
        ? resolvedProjectSettings.settings.defaultModelSelection
        : null,
    personDefault:
      personDefaultModelSelection &&
      !entries.some(
        (entry) => entry.instanceId === personDefaultModelSelection.instanceId && !entry.enabled,
      ) &&
      (!personDefaultHasExplicitProviderSettings ||
        resolveProjectProviderInstanceEnabled(
          settings,
          project?.id ?? null,
          personDefaultModelSelection.instanceId,
        ))
        ? personDefaultModelSelection
        : null,
    providers: entries
      .filter(
        (entry) =>
          entry.enabled &&
          entry.installed &&
          entry.isAvailable &&
          entry.snapshot.auth.status !== "unauthenticated",
      )
      .map((entry) => entry.snapshot),
  });
}

export function resolveComposerDefaultModelSelection(input: {
  readonly isNewThreadDraft: boolean;
  readonly draftModelSelectionExplicit: boolean;
  readonly projectDefaultSelection: ModelSelection | null | undefined;
  readonly personDefaultSelection: ModelSelection | null | undefined;
  readonly settings: Parameters<typeof resolveProjectProviderInstanceEnabled>[0];
  readonly projectId: ProjectId | null;
  readonly providers: ReadonlyArray<ServerProvider>;
}): {
  readonly configuredDefaultSelection: ModelSelection | null;
  readonly personDefaultSelection: ModelSelection | null;
  readonly initialModelSelection: ModelSelection | null;
} {
  const personDefaultSelection =
    input.personDefaultSelection &&
    resolveProjectProviderInstanceEnabled(
      input.settings,
      input.projectId,
      input.personDefaultSelection.instanceId,
    )
      ? input.personDefaultSelection
      : null;
  const projectDefaultSelection = input.projectDefaultSelection ?? null;
  const configuredDefaultSelection = projectDefaultSelection ?? personDefaultSelection;

  if (!input.isNewThreadDraft || input.draftModelSelectionExplicit) {
    return {
      configuredDefaultSelection,
      personDefaultSelection,
      initialModelSelection: null,
    };
  }

  const providers = input.providers.filter(
    (provider) =>
      provider.enabled &&
      provider.installed &&
      provider.availability !== "unavailable" &&
      provider.auth.status !== "unauthenticated" &&
      resolveProjectProviderInstanceEnabled(input.settings, input.projectId, provider.instanceId),
  );
  return {
    configuredDefaultSelection,
    personDefaultSelection,
    initialModelSelection: resolveInitialModelSelection({
      projectDefault: projectDefaultSelection,
      personDefault: personDefaultSelection,
      providers,
    }),
  };
}

export function mapDefaultModelSelectionToPool(
  selection: ModelSelection | null,
  mapToPool: (selection: ModelSelection) => ModelSelection | null,
): ModelSelection | null {
  return selection ? (mapToPool(selection) ?? selection) : null;
}

export function resolveFreshComposerModelSelection(input: {
  readonly isNewThreadDraft: boolean;
  readonly draftModelSelectionExplicit: boolean;
  readonly draftSelection: ModelSelection | null;
  readonly initialModelSelection: ModelSelection | null;
  readonly poolSelection: ModelSelection | null;
}): ModelSelection | null {
  if (!input.isNewThreadDraft) return null;
  if (input.draftModelSelectionExplicit) return input.draftSelection;
  return input.poolSelection ?? input.initialModelSelection;
}
