import {
  DEFAULT_SERVER_SETTINGS,
  ModelFavorites,
  ModelSelection,
  ProviderModelPreferences,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import * as Context from "effect/Context";
import * as Equal from "effect/Equal";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

/** The model-specific server settings one person shares across their clients. */
const ModelSettings = Schema.Struct({
  favorites: Schema.NullOr(ModelFavorites),
  providerModelPreferences: Schema.NullOr(ProviderModelPreferences),
  defaultModelSelection: Schema.NullOr(ModelSelection),
});
const ModelSettingsJson = Schema.fromJsonString(ModelSettings);

export type ModelSettingsSnapshot = typeof ModelSettings.Type;
export type AvailableModels = ReadonlyMap<string, ReadonlySet<string>>;

export const EMPTY_MODEL_SETTINGS: ModelSettingsSnapshot = {
  favorites: null,
  providerModelPreferences: null,
  defaultModelSelection: null,
};

/** Out-of-catalog models are hidden from snapshots until they return. */
export const filterAvailableModels = (
  settings: ModelSettingsSnapshot,
  available: AvailableModels,
): ModelSettingsSnapshot => ({
  favorites:
    settings.favorites === null
      ? null
      : settings.favorites.filter((favorite) =>
          available.get(favorite.provider)?.has(favorite.model),
        ),
  providerModelPreferences:
    settings.providerModelPreferences === null
      ? null
      : Object.fromEntries(
          Object.entries(settings.providerModelPreferences).flatMap(([provider, preferences]) => {
            const models = available.get(provider);
            if (models === undefined) return [];
            return [
              [
                provider,
                {
                  hiddenModels: preferences.hiddenModels.filter((model) => models.has(model)),
                  modelOrder: preferences.modelOrder.filter((model) => models.has(model)),
                },
              ],
            ];
          }),
        ),
  defaultModelSelection:
    settings.defaultModelSelection !== null &&
    available
      .get(settings.defaultModelSelection.instanceId)
      ?.has(settings.defaultModelSelection.model)
      ? settings.defaultModelSelection
      : null,
});

export class ModelSettingsWriteError extends Schema.TaggedError<ModelSettingsWriteError>()(
  "ModelSettingsWriteError",
  { reason: Schema.Literals(["setting-not-supported", "model-not-available"]) },
) {
  override get message(): string {
    return this.reason === "setting-not-supported"
      ? "Cloud model settings only accept model preferences and a default model."
      : "A model setting refers to a model outside the current catalog.";
  }
}

const ALLOWED_PATCH_KEYS = new Set([
  "setModelFavorites",
  "setModelsHidden",
  "setProviderModelOrder",
  "favorites",
  "providerModelPreferences",
  "migrateModelPreferences",
  "defaultModelSelection",
]);

const withAvailableMigration = (patch: ServerSettingsPatch, available: AvailableModels) => {
  const migration = patch.migrateModelPreferences;
  if (migration === undefined) return patch;
  // Legacy browser preferences can belong to another environment. They must not block a valid write.
  const filtered = filterAvailableModels(
    {
      favorites: migration.favorites ?? null,
      providerModelPreferences: migration.providerModelPreferences ?? null,
      defaultModelSelection: null,
    },
    available,
  );
  return {
    ...patch,
    migrateModelPreferences: {
      ...(migration.favorites === undefined ? {} : { favorites: filtered.favorites ?? [] }),
      ...(migration.providerModelPreferences === undefined
        ? {}
        : {
            providerModelPreferences: filtered.providerModelPreferences ?? {},
          }),
    },
  };
};

const validatePatch = (patch: ServerSettingsPatch, available: AvailableModels) =>
  Effect.gen(function* () {
    if (Object.keys(patch).some((key) => !ALLOWED_PATCH_KEYS.has(key))) {
      return yield* Effect.fail(new ModelSettingsWriteError({ reason: "setting-not-supported" }));
    }
    const requireAvailable = (provider: string, model: string) =>
      available.get(provider)?.has(model) === true
        ? Effect.void
        : Effect.fail(new ModelSettingsWriteError({ reason: "model-not-available" }));

    if (patch.defaultModelSelection !== undefined && patch.defaultModelSelection !== null) {
      yield* requireAvailable(
        patch.defaultModelSelection.instanceId,
        patch.defaultModelSelection.model,
      );
    }
    for (const favorite of patch.favorites ?? []) {
      yield* requireAvailable(favorite.provider, favorite.model);
    }
    for (const [provider, models] of Object.entries(patch.providerModelPreferences ?? {})) {
      for (const model of [...models.hiddenModels, ...models.modelOrder]) {
        yield* requireAvailable(provider, model);
      }
    }
    for (const favorite of patch.migrateModelPreferences?.favorites ?? []) {
      yield* requireAvailable(favorite.provider, favorite.model);
    }
    for (const [provider, models] of Object.entries(
      patch.migrateModelPreferences?.providerModelPreferences ?? {},
    )) {
      for (const model of [...models.hiddenModels, ...models.modelOrder]) {
        yield* requireAvailable(provider, model);
      }
    }
    for (const favorite of patch.setModelFavorites ?? []) {
      yield* requireAvailable(favorite.provider, favorite.model);
    }
    for (const hidden of patch.setModelsHidden ?? []) {
      yield* requireAvailable(hidden.provider, hidden.model);
    }
    if (patch.setProviderModelOrder !== undefined) {
      for (const model of patch.setProviderModelOrder.modelOrder) {
        yield* requireAvailable(patch.setProviderModelOrder.provider, model);
      }
    }
  });

export class UserModelSettings extends Context.Service<
  UserModelSettings,
  {
    readonly snapshot: Effect.Effect<ModelSettingsSnapshot, SqlError>;
    /** The current row, then another snapshot after each committed write. */
    readonly changes: Stream.Stream<ModelSettingsSnapshot, SqlError>;
    readonly update: (
      patch: ServerSettingsPatch,
      available: AvailableModels,
    ) => Effect.Effect<ModelSettingsSnapshot, SqlError | ModelSettingsWriteError>;
  }
>()("@signalbox/cloud/user/UserModelSettings") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const changed = yield* PubSub.sliding<void>(1);
  const announce = PubSub.publish(changed, undefined);
  const decodeRows = Schema.decodeUnknownEffect(
    Schema.Array(Schema.Struct({ value: Schema.String })),
  );
  const decodeSettings = Schema.decodeUnknownEffect(ModelSettingsJson);
  const encodeSettings = Schema.encodeEffect(ModelSettingsJson);
  const read = Effect.gen(function* () {
    const rows = yield* sql`SELECT value FROM user_model_settings WHERE id = 1`;
    const [row] = yield* decodeRows(rows).pipe(Effect.orDie);
    return row === undefined
      ? EMPTY_MODEL_SETTINGS
      : yield* decodeSettings(row.value).pipe(Effect.orDie);
  });

  const update: UserModelSettings["Service"]["update"] = (patch, available) =>
    Effect.gen(function* () {
      const prepared = withAvailableMigration(patch, available);
      yield* validatePatch(prepared, available);
      const [next, wrote] = yield* sql.withTransaction(
        Effect.gen(function* () {
          const current = yield* read;
          const settings = applyServerSettingsPatch(
            { ...DEFAULT_SERVER_SETTINGS, ...current },
            prepared,
          );
          const next: ModelSettingsSnapshot = {
            favorites: settings.favorites,
            providerModelPreferences: settings.providerModelPreferences,
            defaultModelSelection: settings.defaultModelSelection,
          };
          if (Equal.equals(current, next)) return [next, false] as const;
          const value = yield* encodeSettings(next).pipe(Effect.orDie);
          yield* sql`INSERT INTO user_model_settings (id, value)
            VALUES (1, ${value})
            ON CONFLICT (id) DO UPDATE SET value = excluded.value`;
          return [next, true] as const;
        }),
      );
      if (wrote) yield* announce;
      return next;
    });

  const changes: UserModelSettings["Service"]["changes"] = Stream.unwrap(
    Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(changed);
      const first = yield* read;
      return Stream.fromSubscription(subscription).pipe(
        Stream.mapEffect(() => read),
        Stream.prepend([first]),
      );
    }),
  );

  return UserModelSettings.of({ snapshot: read, changes, update });
});

export const layer = Layer.effect(UserModelSettings, make);
