// @effect-diagnostics nodeBuiltinImport:off - this file prepares a local proof artifact.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { prepareClaudeTurnProof } from "../claudeTurnProof/prepare.ts";
import { prepareHookChildPrograms } from "./preparePrograms.ts";

const RELEASE_MANIFEST_SHA256 = "175b56b1ef0c5339d405549ddfee987a66afee7b63b0bf2f9a8d51ba40e26f38";

interface PrepareClaudeHooksProofOptions {
  readonly releaseDir: string;
  readonly programDir: string;
  readonly outputDir: string;
}

function requiredPath(name: string, value: string | undefined): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Missing required input ${name}`);
  }
  return NodePath.resolve(value);
}

export async function prepareClaudeHooksProof(options: PrepareClaudeHooksProofOptions) {
  if (options == null) throw new Error("Pass --release, --programs and --output");
  const releaseDir = requiredPath("--release", options.releaseDir);
  const programDir = requiredPath("--programs", options.programDir);
  const outputDir = requiredPath("--output", options.outputDir);
  const manifestBytes = await NodeFSP.readFile(NodePath.join(releaseDir, "manifest.json"));
  const manifestSha256 = NodeCrypto.createHash("sha256").update(manifestBytes).digest("hex");
  if (manifestSha256 !== RELEASE_MANIFEST_SHA256) {
    throw new Error("Claude release manifest does not match the pinned 2.1.302 artifact");
  }

  const children = await prepareHookChildPrograms({ programDir });
  const programs = {
    bash: children.bash,
    busyboxCat: children.busyboxCat,
    ripgrep: children.ripgrep,
  };
  const staging = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "1066-claude-hooks-host-"));
  let summary: Awaited<ReturnType<typeof prepareClaudeTurnProof>>;
  try {
    const hostRuntime = NodePath.join(staging, "host.ts");
    await NodeFSP.writeFile(
      hostRuntime,
      `import {createClaudeTurnProofClass as create} from ${JSON.stringify(NodePath.join(import.meta.dirname, "ClaudeHooksProof.ts"))};\n` +
        `const childPrograms=${JSON.stringify(programs)};\n` +
        "export function createClaudeTurnProofClass(config){return create({...config,childPrograms});}\n",
    );
    summary = await prepareClaudeTurnProof({
      releaseDir,
      outputDir,
      hostRuntime,
      seedAssets: true,
      seedProgramsOnly: true,
      scenario: "tools",
      programArtifacts: {
        bash: NodePath.join(programDir, "bash.wasm"),
        busybox: NodePath.join(programDir, "busybox.wasm"),
        ripgrep: NodePath.join(programDir, "rg.wasm"),
      },
    });
    await NodeFSP.writeFile(
      NodePath.join(outputDir, "child-program-source-inventory.json"),
      JSON.stringify(children.sourceInventory, null, 2) + "\n",
    );
  } finally {
    await NodeFSP.rm(staging, { recursive: true, force: true });
  }
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
    allowPositionals: false,
    options: {
      release: { type: "string" },
      programs: { type: "string" },
      output: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write(
      "Usage: prepareClaude.ts --release <dir> --programs <dir> --output <dir>\n\n" +
        "Required inputs:\n" +
        "  --release <dir>   Pinned Claude 2.1.302 artifact directory\n" +
        "  --programs <dir>  Directory containing bash.wasm, busybox.wasm and rg.wasm\n" +
        "  --output <dir>    Fresh proof output directory\n",
    );
  } else {
    const result = await prepareClaudeHooksProof({
      releaseDir: requiredPath("--release", values.release),
      programDir: requiredPath("--programs", values.programs),
      outputDir: requiredPath("--output", values.output),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
}
