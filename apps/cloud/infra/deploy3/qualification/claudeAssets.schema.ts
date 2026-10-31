import * as Schema from "effect/Schema";

const NonEmpty = Schema.String.check(Schema.isPattern(/\S/u));
const Sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const Bytes = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const AssetPin = Schema.Struct({ path: NonEmpty, bytes: Bytes, sha256: Sha256 });
const BaselinePin = Schema.Struct({
  identity: Schema.Struct({ artifactRef: NonEmpty, artifactHash: Sha256, sourceIdentity: Sha256 }),
  preparedModules: Schema.Record(
    Schema.String,
    Schema.Struct({
      component: Schema.Literals(["codex", "cli", "sdk"]),
      name: NonEmpty,
      path: NonEmpty,
      type: Schema.Literals(["js", "cjs", "text", "wasm"]),
      bytes: Bytes,
      sha256: Sha256,
    }),
  ),
});
const Supplied = Schema.Struct({
  status: Schema.Literal("supplied"),
  purpose: Schema.Literals(["qualification", "release"]),
  projectId: NonEmpty,
  metadata: AssetPin,
  baselinePin: BaselinePin,
  trustedComputer: Schema.Struct({ sourceIdentity: Sha256, manifestSha256: Sha256 }),
  maxPreparedModuleBytes: Schema.Int.check(
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
});
export const Deploy3ClaudeAssets = Schema.Struct({
  schema: Schema.Literal("sb1070/deploy3-claude-assets/v2"),
  ownerIssue: Schema.Literal(1072),
  assets: Schema.Union([
    Schema.Struct({ status: Schema.Literal("awaiting-package"), missing: Schema.Array(NonEmpty) }),
    Supplied,
  ]),
});
export const decodeDeploy3ClaudeAssets = Schema.decodeUnknownSync(Deploy3ClaudeAssets, {
  onExcessProperty: "error",
  reportInput: false,
});
