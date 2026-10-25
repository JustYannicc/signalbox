import {
  type ModelSelection,
  type Project,
  type ProjectId,
  resolveProjectProviderInstanceEnabled,
  type ServerProvider,
  type ServerSettings,
  type ServerSettingsError,
} from "@t3tools/contracts";
import { resolveInitialModelSelection } from "@t3tools/shared/defaultModelSelection";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Effect from "effect/Effect";

export const resolveForProject = (input: {
  readonly projectId: ProjectId;
  readonly project: Project;
  readonly settings: Effect.Effect<ServerSettings, ServerSettingsError>;
  readonly providers: Effect.Effect<ReadonlyArray<ServerProvider>>;
}): Effect.Effect<ModelSelection | null, ServerSettingsError> =>
  Effect.gen(function* () {
    const [settings, providers] = yield* Effect.all([input.settings, input.providers]);
    const effective = resolveProjectSettings(settings, input.projectId, input.project);
    const isUnavailableSavedDefault = (selection: ModelSelection | null | undefined) => {
      if (selection == null) return false;
      const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
      return (
        provider !== undefined &&
        (!provider.enabled ||
          !resolveProjectProviderInstanceEnabled(settings, input.projectId, selection.instanceId) ||
          provider.models.find((model) => model.slug === selection.model)?.isLegacy === true)
      );
    };

    return resolveInitialModelSelection({
      projectDefault: isUnavailableSavedDefault(effective.overrides.defaultModelSelection)
        ? null
        : effective.overrides.defaultModelSelection,
      personDefault: isUnavailableSavedDefault(settings.defaultModelSelection)
        ? null
        : settings.defaultModelSelection,
      providers: providers.filter(
        (provider) =>
          provider.enabled &&
          provider.installed &&
          provider.auth.status !== "unauthenticated" &&
          provider.availability !== "unavailable" &&
          resolveProjectProviderInstanceEnabled(settings, input.projectId, provider.instanceId),
      ),
    });
  });
