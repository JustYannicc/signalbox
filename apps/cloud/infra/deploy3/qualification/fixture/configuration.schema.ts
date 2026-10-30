import * as Schema from "effect/Schema";
import { PreparedRelease } from "../preparedRelease.schema.ts";
import { Deploy3ClaudeAssets } from "../claudeAssets.schema.ts";
import { ClaudeMcpProbe } from "./claudeMcpProbe.ts";
import { ProgramCatalog, MachineInventory } from "./computerConfiguration.ts";
import { SeedConfiguration } from "./seedConfiguration.ts";

const Text = Schema.NonEmptyString;
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const Revision = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u));
const Size = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
export const AssetPinSchema = Schema.Struct({ path: Text, bytes: Size, sha256: Hash });
export const ClaudeSeedConfiguration = Schema.Struct({
  home: Schema.String.check(Schema.isPattern(/^\/workspace\/(?!.*(?:^|\/)\.\.(?:\/|$))\S+$/u)),
  cwd: Schema.Literal("/workspace"),
});
const ChunkedAsset = Schema.Struct({
  ...AssetPinSchema.fields,
  chunks: Schema.Array(Schema.Struct({ ...AssetPinSchema.fields, offset: Size })),
});
const base = {
  schema: Schema.Literal("sb1070/qualifier-input/v1"),
  runId: Schema.String.check(
    Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu),
  ),
  workerName: Text,
  mainCommit: Revision,
  mainTree: Revision,
  expectedRelease: PreparedRelease,
  releaseFiles: Schema.Record(Schema.String, ChunkedAsset),
  releaseLoaderConfig: Schema.Struct({
    trustedComputer: Schema.Struct({ sourceIdentity: Hash, manifestSha256: Hash }),
    maxPreparedModuleBytes: Size.check(Schema.isGreaterThan(0)),
  }),
  programCatalog: ProgramCatalog,
  programPaths: Schema.Record(Schema.String, AssetPinSchema),
  machineInventory: MachineInventory,
  seed: SeedConfiguration,
  turnJson: Schema.Array(Text).check(Schema.isMinLength(1)),
  commandRegistryHashes: Schema.Array(Hash),
  observer: Schema.Struct({ routePinsSha256: Hash, producerListSha256: Hash }),
  sourcePins: Schema.Record(Schema.String, Hash),
};
export const BaseConfiguration = Schema.Struct(base);
export const ConfigurationSchema = Schema.Struct({
  ...base,
  facetSource: Text,
  claude: Schema.Struct({
    runtime: Schema.Struct({
      schema: Schema.Literal("sb1070/deploy3-claude-facet/v1"),
      purpose: Schema.Literal("qualification"),
      assets: Deploy3ClaudeAssets,
      workload: Schema.Struct({
        collectorNonce: Text,
        apiRevision: Schema.Literal("EC1APIr2"),
        model: Text,
        mcpProbe: ClaudeMcpProbe,
      }),
      turnJson: Schema.Struct({ baseline: Schema.Array(Text), hooks: Schema.Array(Text) }),
      seed: ClaudeSeedConfiguration,
    }),
    facetSource: Text,
    environmentPackages: Schema.Record(Schema.String, AssetPinSchema),
    expected: Schema.Struct({ baseline: PreparedRelease, hooks: PreparedRelease }),
  }),
});

export const decodeBaseConfiguration = Schema.decodeUnknownSync(BaseConfiguration, {
  onExcessProperty: "error",
  reportInput: false,
});
export const decodeConfiguration = Schema.decodeUnknownSync(ConfigurationSchema, {
  onExcessProperty: "error",
  reportInput: false,
});
