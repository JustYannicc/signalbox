import * as Schema from "effect/Schema";

const NonEmpty = Schema.String.check(Schema.isPattern(/\S/));
const Sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const ByteCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Names = Schema.Record(NonEmpty, NonEmpty);
export const FileDescriptor = Schema.Struct({ bytes: ByteCount, sha256: Sha256 });
const ModuleDescriptor = Schema.Struct({
  ...FileDescriptor.fields,
  path: NonEmpty,
  type: Schema.Literals(["js", "cjs", "text", "wasm"]),
});
const Modules = Schema.Record(NonEmpty, ModuleDescriptor);
const RequiredHostModules = Schema.Array(NonEmpty);
const ModuleMap = Schema.Struct({ path: NonEmpty, sha256: Sha256 });
const Asset = Schema.Struct({
  ...FileDescriptor.fields,
  path: NonEmpty,
  key: NonEmpty,
  loader: ByteCount,
  encoding: ByteCount,
});

export const decodeCodexManifest = Schema.decodeUnknownSync(
  Schema.Struct({
    abiVersion: Schema.Literal(1),
    target: Schema.Literal("wasm32-wasip1"),
    version: NonEmpty,
    upstreamCommit: NonEmpty,
    moduleBytes: ByteCount,
    moduleSha256: Sha256,
    moduleBudgetBytes: ByteCount,
    moduleBudgetPassed: Schema.Literal(true),
    files: Schema.Record(NonEmpty, FileDescriptor),
  }),
);

export const decodeCliManifest = Schema.decodeUnknownSync(
  Schema.Struct({
    schemaVersion: Schema.Literal(1),
    release: Schema.Struct({
      provider: Schema.Literal("claude-code"),
      version: NonEmpty,
      platform: NonEmpty,
      binarySha256: Sha256,
    }),
    mainModule: NonEmpty,
    mainExport: NonEmpty,
    embeddedEntrypointExport: NonEmpty,
    embeddedEntrypoints: Names,
    hostEntrypoints: Names,
    moduleMap: ModuleMap,
    modules: Modules,
    assets: Schema.Record(NonEmpty, Asset),
    requiredHostModules: RequiredHostModules,
    environmentPackageModules: Schema.Record(NonEmpty, FileDescriptor),
    bytes: ByteCount,
  }),
);

export const decodeSdkManifest = Schema.decodeUnknownSync(
  Schema.Struct({
    schemaVersion: Schema.Literal(1),
    release: Schema.Struct({
      provider: Schema.Literal("agent-sdk"),
      name: Schema.Literal("@anthropic-ai/claude-agent-sdk"),
      version: NonEmpty,
      integrity: NonEmpty,
      tarballSha256: Sha256,
    }),
    mainModule: NonEmpty,
    initializeExport: NonEmpty,
    modules: Modules,
    requiredHostModules: RequiredHostModules,
    moduleMap: Schema.optional(ModuleMap),
  }),
);
