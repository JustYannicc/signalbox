import * as Schema from "effect/Schema";
import { CHILD_COREUTILS_COMMANDS } from "../../../../src/computer/ChildProgramSet.ts";

const Text = Schema.NonEmptyString;
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const Revision = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u));
const Natural = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const Digest = Schema.TemplateLiteral(["sha256:", Hash]);
const Pin = Schema.Struct({ bytes: Natural, sha256: Hash });
const Code = Schema.Struct({
  mainModule: Text,
  modules: Schema.Record(
    Schema.String,
    Schema.Union([
      Schema.String,
      Schema.Struct({ js: Schema.String }),
      Schema.Struct({ wasmReference: Text }),
    ]),
  ),
  entrypoint: Schema.optionalKey(Text),
  limits: Schema.optionalKey(Schema.Struct({ cpuMs: Natural.check(Schema.isGreaterThan(0)) })),
  executableArtifact: Schema.optionalKey(Pin),
});

export const ProgramCatalog = Schema.Struct({
  sourceIdentity: Text,
  codes: Schema.Struct({
    bash: Code,
    busyboxCat: Code,
    busyboxApplets: Code,
    productBusyboxApplets: Code,
    ripgrep: Code,
    coreutils: Schema.Record(Schema.Literals(CHILD_COREUTILS_COMMANDS), Code),
    git: Code,
    sed: Code,
    jq: Code,
    ugrep: Code,
  }),
  files: Schema.Record(
    Schema.String,
    Schema.Struct({
      bytes: Natural,
      sha256: Hash,
      mode: Natural,
      uid: Natural,
      gid: Natural,
    }),
  ),
});

export const MachineInventory = Schema.Struct({
  format: Schema.Literal("signalbox-machine-files-v1"),
  imageRef: Text,
  imageDigest: Digest,
  platform: Text,
  provenance: Schema.Struct({
    sourceRevision: Revision,
    sourceImageId: Digest,
    dockerfile: Text,
    captureSha256: Hash,
    snapshotSha256: Schema.optionalKey(Hash),
  }),
  path: Schema.Array(Text),
  excludedRoots: Schema.Array(Text),
  entries: Schema.Array(
    Schema.Struct({
      path: Text,
      type: Schema.Literals([
        "file",
        "directory",
        "symlink",
        "fifo",
        "socket",
        "character",
        "block",
        "unknown",
      ]),
      size: Text,
      nlink: Text,
      atimeNs: Text,
      mtimeNs: Text,
      ctimeNs: Text,
      mode: Natural,
      uid: Natural,
      gid: Natural,
      target: Schema.optionalKey(Text),
      ino: Schema.optionalKey(Text),
      dev: Schema.optionalKey(Text),
    }),
  ),
  imageContent: Schema.optionalKey(
    Schema.Struct({
      format: Schema.Literal("signalbox-machine-image-content-v1"),
      imageDigest: Digest,
      captureSha256: Hash,
      inventorySha256: Hash,
      includeRule: Schema.Literal("regular-files-under-/etc"),
      fileCount: Natural,
      totalBytes: Natural,
      entries: Schema.Array(
        Schema.Struct({ path: Text, size: Text, sha256: Hash, bytesBase64: Schema.String }),
      ),
    }),
  ),
});
