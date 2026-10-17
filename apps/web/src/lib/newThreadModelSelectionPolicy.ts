import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ServerProvider,
  ServerSettings,
} from "@t3tools/contracts";
import {
  resolveProjectSettings,
  type LegacyProjectSettingsFields,
} from "@t3tools/shared/projectSettings";
import type { ComposerThreadDraftState, DraftId } from "../composerDraftStore";
import {
  hasExplicitComposerModelSelection,
  resolveNewThreadModelSelectionOverride,
} from "./chatThreadActions";
import { resolveComposerDefaultModelSelection } from "./defaultModelSelectionPolicy";

export function resolveProjectDraftStartingModelSelection(input: {
  readonly project: LegacyProjectSettingsFields & {
    readonly id: ProjectId;
    readonly environmentId: EnvironmentId;
  };
  readonly environmentConfig:
    | {
        readonly settings: ServerSettings;
        readonly providers: ReadonlyArray<ServerProvider>;
      }
    | null
    | undefined;
  readonly mapToPool: (selection: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
    readonly selection: ModelSelection | null;
    readonly providerInstances: ServerSettings["providerInstances"];
    readonly providers: ReadonlyArray<ServerProvider>;
  }) => ModelSelection | null;
}): ModelSelection | null {
  const settings = input.environmentConfig?.settings ?? DEFAULT_SERVER_SETTINGS;
  const resolvedSettings = resolveProjectSettings(settings, input.project.id, input.project);
  const initialModelSelection = resolveComposerDefaultModelSelection({
    isNewThreadDraft: true,
    draftModelSelectionExplicit: false,
    projectDefaultSelection:
      resolvedSettings.sources.defaultModelSelection === "project"
        ? resolvedSettings.settings.defaultModelSelection
        : null,
    personDefaultSelection: input.environmentConfig?.settings.defaultModelSelection ?? null,
    settings: resolvedSettings.settings,
    projectId: input.project.id,
    providers: input.environmentConfig?.providers ?? [],
  }).initialModelSelection;
  const poolSelection = input.environmentConfig
    ? input.mapToPool({
        environmentId: input.project.environmentId,
        projectId: input.project.id,
        selection: initialModelSelection,
        providerInstances: input.environmentConfig.settings.providerInstances,
        providers: input.environmentConfig.providers,
      })
    : null;
  return poolSelection || initialModelSelection;
}

export function explicitCarryModelSelection(
  draft: Pick<
    ComposerThreadDraftState,
    "activeProvider" | "modelSelectionByProvider" | "modelSelectionExplicit"
  > | null,
): ModelSelection | null {
  const provider = draft?.activeProvider;
  return hasExplicitComposerModelSelection(draft) && provider
    ? (draft.modelSelectionByProvider[provider] ?? null)
    : null;
}

export function resolveNewThreadInitialModelSelection(input: {
  readonly projectDefaultIsConfigured: boolean;
  readonly projectDefaultSelection: ModelSelection | null | undefined;
  readonly personDefaultSelection: ModelSelection | null | undefined;
  readonly settings: Parameters<typeof resolveComposerDefaultModelSelection>[0]["settings"];
  readonly projectId: ProjectId | null;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly explicitCarrySelection: ModelSelection | null;
  readonly carrySourceDraftId: DraftId | null;
  readonly destinationDraftId: DraftId;
}): { readonly selection: ModelSelection | null; readonly explicit: boolean } {
  const defaults = resolveComposerDefaultModelSelection({
    isNewThreadDraft: true,
    draftModelSelectionExplicit: false,
    projectDefaultSelection: input.projectDefaultIsConfigured
      ? input.projectDefaultSelection
      : null,
    personDefaultSelection: input.personDefaultSelection,
    settings: input.settings,
    projectId: input.projectId,
    providers: input.providers,
  });
  const carried =
    defaults.configuredDefaultSelection === null
      ? resolveNewThreadModelSelectionOverride({
          projectDefaultSelection: null,
          carrySelection: input.explicitCarrySelection,
          carrySourceDraftId: input.carrySourceDraftId,
          destinationDraftId: input.destinationDraftId,
        })
      : null;
  return {
    selection: carried ?? defaults.initialModelSelection,
    explicit: carried !== null,
  };
}
