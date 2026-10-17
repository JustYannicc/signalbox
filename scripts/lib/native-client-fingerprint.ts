import * as Schema from "effect/Schema";

const ExpoSourceFields = {
  reasons: Schema.Array(Schema.String),
  hash: Schema.NullOr(Schema.String),
};

/** Expo source identity without its raw contents or diagnostic-only debug data. */
export const ExpoFingerprintSource = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("file"),
    filePath: Schema.String,
    ...ExpoSourceFields,
    overrideHashKey: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("dir"),
    filePath: Schema.String,
    ...ExpoSourceFields,
    overrideHashKey: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("contents"),
    id: Schema.String,
    ...ExpoSourceFields,
  }),
  Schema.Struct({
    type: Schema.Literal("package"),
    name: Schema.String,
    version: Schema.String,
    filePath: Schema.String,
    ...ExpoSourceFields,
    overrideHashKey: Schema.optional(Schema.String),
  }),
]);

const ExpoFingerprint = Schema.Struct({
  hash: Schema.String,
  sources: Schema.Array(ExpoFingerprintSource),
});

export const decodeExpoFingerprint = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ExpoFingerprint),
);

export type ExpoFingerprintSource = typeof ExpoFingerprintSource.Type;
export type ExpoFingerprintSnapshot = typeof ExpoFingerprint.Type;

/** Keep only stable source identity and provenance from Expo's larger debug objects. */
export const projectExpoFingerprintSource: (
  source: ExpoFingerprintSource,
) => ExpoFingerprintSource = function projectExpoFingerprintSource(source) {
  const common = { type: source.type, reasons: source.reasons, hash: source.hash };
  switch (source.type) {
    case "contents":
      return { ...common, type: source.type, id: source.id };
    case "file":
    case "dir":
      return {
        ...common,
        type: source.type,
        filePath: source.filePath,
        ...(source.overrideHashKey === undefined
          ? {}
          : { overrideHashKey: source.overrideHashKey }),
      };
    case "package":
      return {
        ...common,
        type: source.type,
        name: source.name,
        version: source.version,
        filePath: source.filePath,
        ...(source.overrideHashKey === undefined
          ? {}
          : { overrideHashKey: source.overrideHashKey }),
      };
  }
};
