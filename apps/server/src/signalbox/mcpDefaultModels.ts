import {
  type ModelSelection,
  type Project,
  type ProjectId,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { resolveInitialModelSelection } from "@t3tools/shared/defaultModelSelection";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Effect from "effect/Effect";

export const resolveForProvider = <ProjectError, SettingsError>(input: {
  readonly projectId: ProjectId;
  readonly provider: ServerProvider;
  readonly project: Effect.Effect<Project, ProjectError>;
  readonly settings: Effect.Effect<ServerSettings, SettingsError>;
}): Effect.Effect<ModelSelection | null, ProjectError | SettingsError> =>
  Effect.gen(function* () {
    const [project, settings] = yield* Effect.all([input.project, input.settings]);
    const effective = resolveProjectSettings(settings, input.projectId, project);
    return resolveInitialModelSelection({
      projectDefault:
        effective.overrides.defaultModelSelection?.instanceId === input.provider.instanceId
          ? effective.overrides.defaultModelSelection
          : null,
      personDefault:
        settings.defaultModelSelection?.instanceId === input.provider.instanceId
          ? settings.defaultModelSelection
          : null,
      providers: [input.provider],
    });
  });
