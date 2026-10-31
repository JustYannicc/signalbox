import * as Schema from "effect/Schema";
import { snapshotPreparedRelease } from "../../../src/harness/ProductHarnessProcessRelease.ts";

const NonEmpty = Schema.String.check(Schema.isPattern(/\S/u));
const Sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const Bytes = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const File = Schema.Struct({ bytes: Bytes, sha256: Sha256 });
const Computer = Schema.Struct({ sourceIdentity: Sha256, manifestSha256: Sha256 });
export const PreparedRelease = Schema.Struct({
  artifact: Schema.Struct({
    provider: Schema.Literals(["codex", "claude-code"]),
    releaseId: NonEmpty,
    artifactRef: NonEmpty,
    artifactHash: Sha256,
    sourceIdentity: Sha256,
    fixtureIdentity: NonEmpty,
    createdAt: NonEmpty,
  }),
  plan: Schema.Struct({
    release: Schema.Struct({
      harness: Schema.Literals(["codex", "claude-code"]),
      version: NonEmpty,
      manifestSha256: Sha256,
      modules: Schema.Record(Schema.String, File),
    }),
    sourceIdentity: Sha256,
    computer: Computer,
    preparedModules: Schema.Record(
      Schema.String,
      Schema.Struct({
        component: Schema.Literals(["codex", "cli", "sdk"]),
        name: NonEmpty,
        path: NonEmpty,
        type: Schema.Literals(["wasm", "js", "cjs", "text"]),
        bytes: Bytes,
        sha256: Sha256,
      }),
    ),
  }),
});
const decode = Schema.decodeUnknownSync(PreparedRelease, {
  onExcessProperty: "error",
  reportInput: false,
});

export function decodePreparedRelease(raw: unknown) {
  const parsed = decode(raw);
  const value = snapshotPreparedRelease(parsed);
  if (!value) throw new Error("DEPLOY3_PREPARED_RELEASE_INVALID");
  return value;
}
