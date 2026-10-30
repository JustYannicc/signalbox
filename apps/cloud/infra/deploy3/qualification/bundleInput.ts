import { ClaudeMcpProbe } from "./fixture/claudeMcpProbe.ts";
import * as Schema from "effect/Schema";
import { Deploy3ClaudeAssets } from "./claudeAssets.schema.ts";

const NonEmpty = Schema.String.check(Schema.isPattern(/\S/u));
const Sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const Bytes = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
export const FixtureFilePin = Schema.Struct({ path: NonEmpty, bytes: Bytes, sha256: Sha256 });

export const CombinedFixtureInput = Schema.Struct({
  schema: Schema.Literal("signalbox/deploy3-combined-fixture/v1"),
  classification: Schema.Literals(["synthetic", "official"]),
  assetsDirectory: NonEmpty,
  outputDirectory: NonEmpty,
  codex: Schema.Struct({
    configuration: FixtureFilePin,
    engine: FixtureFilePin,
    commands: Schema.Array(FixtureFilePin),
  }),
  claude: Deploy3ClaudeAssets,
  claudeEnvironmentPackages: Schema.Record(Schema.String, FixtureFilePin),
  claudeRuntime: Schema.Struct({
    collectorNonce: NonEmpty,
    mcpProbe: ClaudeMcpProbe,
    model: NonEmpty,
    turnJson: Schema.Struct({ baseline: Schema.Array(NonEmpty), hooks: Schema.Array(NonEmpty) }),
    seed: Schema.Struct({
      home: Schema.String.check(Schema.isPattern(/^\/\S/u)),
      cwd: Schema.String.check(Schema.isPattern(/^\/\S/u)),
    }),
  }),
});

export const decodeCombinedFixtureInput = Schema.decodeUnknownSync(CombinedFixtureInput, {
  onExcessProperty: "error",
  reportInput: false,
});
