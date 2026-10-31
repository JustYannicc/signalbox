import { ProviderDriverKind } from "@t3tools/contracts";
import type { HarnessProcessResumePreparedRelease } from "../../../src/harness/HarnessProcessResume.ts";
import { prepareHarnessFilesCheckpoint } from "../../../src/harness/HarnessFilesStore.ts";
import { CHILD_COREUTILS_COMMANDS } from "../../../src/computer/ChildProgramSet.ts";
import { sha256, toBase64 } from "./fixture/common.ts";
import { deploy3BootstrapIdentity } from "../expiry.ts";
import type { RunnerTurn } from "@signalbox/runner-protocol/RunnerProtocol";
import { RunnerTurn as RunnerTurnSchema } from "@signalbox/runner-protocol/RunnerProtocol";
import * as Schema from "effect/Schema";
const encodeTurn = Schema.encodeSync(Schema.fromJsonString(Schema.toCodecJson(RunnerTurnSchema)));

export async function syntheticConfiguration(
  release: HarnessProcessResumePreparedRelease,
  turn: RunnerTurn,
) {
  const bytes = new TextEncoder().encode("synthetic checkpoint seed\n");
  const file = { path: "workspace/synthetic-seed.txt", mode: 0o644, bytes };
  const checkpoint = { checkpointId: "synthetic-seed", parentCheckpointId: null, files: [file] };
  const prepared = await prepareHarnessFilesCheckpoint(checkpoint);
  const code = {
    mainModule: "synthetic.js",
    modules: {
      "synthetic.js": { js: "throw new Error('Synthetic programs cannot execute official work');" },
    },
  };
  const digest = `sha256:${"c".repeat(64)}`;
  return {
    schema: "sb1070/qualifier-input/v1",
    runId: "00000000-0000-4000-8000-000000000001",
    workerName: deploy3BootstrapIdentity("00000000", Date.parse("2026-10-30T00:00:00Z")).workerName,
    mainCommit: "1".repeat(40),
    mainTree: "2".repeat(40),
    expectedRelease: release,
    releaseFiles: {},
    releaseLoaderConfig: { trustedComputer: release.plan.computer, maxPreparedModuleBytes: 4096 },
    programCatalog: {
      sourceIdentity: "synthetic-programs",
      codes: {
        bash: code,
        busyboxCat: code,
        busyboxApplets: code,
        productBusyboxApplets: code,
        ripgrep: code,
        coreutils: Object.fromEntries(CHILD_COREUTILS_COMMANDS.map((name) => [name, code])),
        git: code,
        sed: code,
        jq: code,
        ugrep: code,
      },
      files: {},
    },
    programPaths: {},
    machineInventory: {
      format: "signalbox-machine-files-v1",
      imageRef: `synthetic@${digest}`,
      imageDigest: digest,
      platform: "linux/amd64",
      provenance: {
        sourceRevision: "3".repeat(40),
        sourceImageId: digest,
        dockerfile: "synthetic",
        captureSha256: "d".repeat(64),
      },
      path: ["/bin"],
      excludedRoots: [],
      entries: [
        {
          path: "/",
          type: "directory",
          size: "0",
          nlink: "1",
          atimeNs: "0",
          mtimeNs: "0",
          ctimeNs: "0",
          mode: 0o755,
          uid: 1000,
          gid: 1000,
        },
      ],
    },
    seed: {
      ...checkpoint,
      manifestSha256: prepared.manifestSha256,
      files: [
        {
          path: file.path,
          mode: file.mode,
          bytes: bytes.length,
          sha256: await sha256(bytes),
          contentBase64: toBase64(bytes),
        },
      ],
    },
    turnJson: [0, 1, 2].map(() =>
      encodeTurn({
        ...turn,
        providerThread: { ...turn.providerThread, driver: ProviderDriverKind.make("codex") },
      }),
    ),
    commandRegistryHashes: [],
    observer: { routePinsSha256: "e".repeat(64), producerListSha256: "f".repeat(64) },
    sourcePins: {},
  };
}
