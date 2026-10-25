import * as Schema from "effect/Schema";

/** The provider harness CLIProxyAPI attaches a model definition to. */
export const ModelChannel = Schema.Literals(["claude", "codex"]);
export type ModelChannel = typeof ModelChannel.Type;

/** A model the CLIProxyAPI serves, plus optional picker metadata. */
export interface ServedModel {
  readonly id: string;
  readonly ownedBy: string;
  /** When the model came out, in epoch seconds, if the CLIProxyAPI knows. */
  readonly created: number | null;
  readonly displayName?: string | undefined;
  readonly provider?: ModelChannel | undefined;
  /** Empty when definitions confirm the model has no effort choices. */
  readonly reasoningEfforts?: ReadonlyArray<string> | undefined;
  /** Present only when this pool explicitly registered the model with a local transport. */
  readonly registration?: { readonly kind: "local"; readonly transportId: string } | undefined;
}

const ModelDefinition = Schema.Struct({
  id: Schema.String,
  display_name: Schema.optional(Schema.String),
  thinking: Schema.optional(
    Schema.Struct({ levels: Schema.optional(Schema.Array(Schema.String)) }),
  ),
});

const ModelDefinitions = Schema.Struct({
  channel: ModelChannel,
  models: Schema.Array(ModelDefinition),
});

export type ModelDefinitions = typeof ModelDefinitions.Type;
export const decodeModelDefinitions = Schema.decodeUnknownEffect(ModelDefinitions);

/** The API owner used by `/v1/models` for each provider's model definitions. */
export const channelForOwner = (ownedBy: string): ModelChannel | undefined => {
  switch (ownedBy) {
    case "anthropic":
      return "claude";
    case "openai":
      return "codex";
    default:
      return undefined;
  }
};

const nonBlank = (value: string | undefined) => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
};

/** Adds metadata only when both the served model's id and channel match. */
export const withMetadata = (
  models: ReadonlyArray<ServedModel>,
  definitions: ReadonlyArray<ModelDefinitions>,
): ReadonlyArray<ServedModel> => {
  const byChannelAndId = new Map(
    definitions.flatMap(({ channel, models: channelModels }) =>
      channelModels.map((model) => [`${channel}\u0000${model.id}`, model] as const),
    ),
  );

  return models.map((model) => {
    const channel = channelForOwner(model.ownedBy);
    if (channel === undefined) return model;
    const definition = byChannelAndId.get(`${channel}\u0000${model.id}`);
    if (definition === undefined) return { ...model, provider: channel };

    const displayName = nonBlank(definition.display_name);
    const reasoningEfforts = (definition.thinking?.levels ?? [])
      .map((level) => nonBlank(level))
      .filter((level): level is string => level !== undefined);

    return {
      ...model,
      provider: channel,
      ...(displayName === undefined ? {} : { displayName }),
      reasoningEfforts,
    };
  });
};
