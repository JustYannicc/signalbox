// @effect-diagnostics nodeBuiltinImport:off - this file prepares a local proof artifact.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { prepareClaudeTurnProof } from "../claudeTurnProof/prepare.ts";

const RELEASE_DIR = "/tmp/issue-1066/claude-release-2.1.302";
const RELEASE_MANIFEST_SHA256 = "175b56b1ef0c5339d405549ddfee987a66afee7b63b0bf2f9a8d51ba40e26f38";
const PROGRAM_DIR = "/tmp/issue-1066/programs";
const DEFAULT_OUTPUT_DIR = "/tmp/issue-1066/claude-work/prepared";

export async function prepareClaudeHooksProof(
  options: {
    readonly releaseDir?: string;
    readonly outputDir?: string;
  } = {},
) {
  const releaseDir = NodePath.resolve(options.releaseDir ?? RELEASE_DIR);
  const outputDir = NodePath.resolve(options.outputDir ?? DEFAULT_OUTPUT_DIR);
  const manifestBytes = await NodeFSP.readFile(NodePath.join(releaseDir, "manifest.json"));
  const manifestSha256 = NodeCrypto.createHash("sha256").update(manifestBytes).digest("hex");
  if (manifestSha256 !== RELEASE_MANIFEST_SHA256) {
    throw new Error("Claude release manifest does not match the pinned 2.1.302 artifact");
  }

  const summary = await prepareClaudeTurnProof({
    releaseDir,
    outputDir,
    hostRuntime: NodePath.join(import.meta.dirname, "ClaudeHooksProof.ts"),
    seedAssets: true,
    scenario: "tools",
    programArtifacts: {
      bash: NodePath.join(PROGRAM_DIR, "bash.wasm"),
      busybox: NodePath.join(PROGRAM_DIR, "busybox.wasm"),
      ripgrep: NodePath.join(PROGRAM_DIR, "rg.wasm"),
    },
  });
  const manifestPath = NodePath.join(outputDir, "manifest.json");
  const proofManifest = JSON.parse(await NodeFSP.readFile(manifestPath, "utf8")) as Record<
    string,
    unknown
  >;
  if (proofManifest.id !== "claude-turn-proof" || proofManifest.entrypoint !== "ClaudeTurnProof") {
    throw new Error("Prepared Claude host manifest has an unexpected entry point");
  }
  proofManifest.allowGeneratedCode = true;
  proofManifest.allowChildWorkers = true;
  await NodeFSP.writeFile(manifestPath, JSON.stringify(proofManifest, null, 2) + "\n");
  return { ...summary, generatedCodeEnabled: true };
}

if (process.argv[1] === import.meta.filename) {
  const { values } = NodeUtil.parseArgs({
    options: {
      release: { type: "string" },
      output: { type: "string" },
    },
  });
  process.stdout.write(
    JSON.stringify(
      await prepareClaudeHooksProof({
        ...(values.release === undefined ? {} : { releaseDir: values.release }),
        ...(values.output === undefined ? {} : { outputDir: values.output }),
      }),
      null,
      2,
    ) + "\n",
  );
}
