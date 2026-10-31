import * as Schema from "effect/Schema";
import { prepareHarnessFilesCheckpoint } from "../../../../src/harness/HarnessFilesStore.ts";
import { validateHarnessCProductFiles } from "../../../../src/harness/HarnessCProductCheckpoint.ts";
import { fromBase64, toBase64, sha256 } from "./common.ts";

const Text = Schema.NonEmptyString;
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const Size = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);

export const SeedConfiguration = Schema.Struct({
  checkpointId: Text,
  parentCheckpointId: Schema.NullOr(Text),
  manifestSha256: Hash,
  files: Schema.Array(
    Schema.Struct({
      path: Text,
      mode: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(0o7777)),
      kind: Schema.optionalKey(Schema.Literals(["file", "symlink"])),
      bytes: Size,
      sha256: Hash,
      contentBase64: Schema.String,
    }),
  ).check(Schema.isMinLength(1)),
});
const decode = Schema.decodeUnknownSync(SeedConfiguration, {
  onExcessProperty: "error",
  reportInput: false,
});

export async function verifySeedConfiguration(raw: unknown) {
  const seed = decode(raw);
  const files = await Promise.all(
    seed.files.map(async (file) => {
      const bytes = fromBase64(file.contentBase64);
      if (
        toBase64(bytes) !== file.contentBase64 ||
        bytes.length !== file.bytes ||
        (await sha256(bytes)) !== file.sha256
      )
        throw new Error("DEPLOY3_SEED_FILE_BYTES_CHANGED");
      return {
        path: file.path,
        mode: file.mode,
        ...(file.kind === undefined ? {} : { kind: file.kind }),
        bytes,
      };
    }),
  );
  validateHarnessCProductFiles(files);
  const checkpoint = {
    checkpointId: seed.checkpointId,
    parentCheckpointId: seed.parentCheckpointId,
    files,
  };
  const prepared = await prepareHarnessFilesCheckpoint(checkpoint);
  if (prepared.manifestSha256 !== seed.manifestSha256)
    throw new Error("DEPLOY3_SEED_CHECKPOINT_MANIFEST_CHANGED");
  return { seed, checkpoint };
}
