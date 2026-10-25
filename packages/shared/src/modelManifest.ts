/**
 * The shape of T3's model manifest (`apps/server/src/provider/model-manifest.json`)
 * that any reader can decode: the per-driver catalogs with each model's name,
 * status and capability profile. The self-hosted server reads it through
 * `apps/server/src/provider/ModelManifest.ts`, which adds its compatibility
 * policies and adapter checks; Signalbox Cloud reads the catalogs to label
 * the models its pools serve.
 */
import {
  ModelCapabilities,
  ModelDefaultSelection,
  ModelPricing,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/** Where the manifest lives upstream; a server refreshes its bundled copy from here. */
export const MODEL_MANIFEST_URL =
  "https://raw.githubusercontent.com/pingdotgg/t3code/main/apps/server/src/provider/model-manifest.json";

const ManifestModelStatus = Schema.Literals(["current", "legacy"]);

const ManifestModelProfile = Schema.Struct({
  capabilities: Schema.optional(ModelCapabilities),
  adapter: Schema.optional(Schema.Unknown),
});

const ManifestProviderModel = Schema.Struct({
  slug: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  shortName: Schema.optional(TrimmedNonEmptyString),
  subProvider: Schema.optional(TrimmedNonEmptyString),
  aliases: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  status: ManifestModelStatus,
  badge: Schema.optional(Schema.Literal("new")),
  profile: Schema.optional(TrimmedNonEmptyString),
  pricing: Schema.optional(ModelPricing),
  defaultSelection: Schema.optional(ModelDefaultSelection),
  adapter: Schema.optional(Schema.Unknown),
});

export const ManifestProviderCatalog = Schema.Struct({
  defaults: Schema.optional(
    Schema.Struct({
      chat: Schema.optional(TrimmedNonEmptyString),
    }),
  ),
  profiles: Schema.Record(Schema.String, ManifestModelProfile),
  models: Schema.Array(ManifestProviderModel),
});

/** The parts of the manifest a reader that only labels models needs. */
export const ModelManifestCatalogs = Schema.Struct({
  version: Schema.Literal(1),
  updatedAt: Schema.optional(Schema.String),
  providers: Schema.optional(Schema.Record(Schema.String, ManifestProviderCatalog)),
});
export type ModelManifestCatalogs = typeof ModelManifestCatalogs.Type;

/**
 * Epoch millis of the manifest's `updatedAt`, or 0 when absent or unparsable.
 * A copy edited earlier than the one in hand never replaces it.
 */
export const manifestUpdatedAtMs = (manifest: { readonly updatedAt?: string | undefined }) => {
  if (manifest.updatedAt === undefined) return 0;
  const parsed = Date.parse(manifest.updatedAt);
  return Number.isNaN(parsed) ? 0 : parsed;
};
