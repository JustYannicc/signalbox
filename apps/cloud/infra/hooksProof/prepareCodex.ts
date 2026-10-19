// @effect-diagnostics nodeBuiltinImport:off - this file packages a local proof artifact.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import { build } from "esbuild";
// @ts-expect-error The existing MJS packager has no declaration; the local type below narrows its API.
import { createCodexFixture as createCodexFixtureUntyped } from "../codexTurn/fixturePackager.mjs";

interface CodexFixturePackagerOptions {
  readonly artifactDir: string;
  readonly expectedManifestSha256: string;
  readonly entryModulePath: string;
  readonly outputDir: string;
  readonly id: string;
  readonly paths: readonly string[];
  readonly additionalModules: Readonly<
    Record<
      string,
      {
        readonly path: string;
        readonly type: "wasm";
        readonly bytes: number;
        readonly sha256: string;
      }
    >
  >;
}

interface CodexFixturePackage {
  readonly outputDir: string;
  readonly manifest: Record<string, unknown>;
  readonly inventory: Record<string, unknown>;
}

const createCodexFixture = createCodexFixtureUntyped as unknown as (
  options: CodexFixturePackagerOptions,
) => Promise<CodexFixturePackage>;

const RELEASE_MANIFEST_SHA256 = "bfa4263733024c07900c856b7ff17a6e6b664fc4dd5eaad54065532f34c1b91b";
const BASH_ARTIFACT = Object.freeze({
  bytes: 3_887_571,
  sha256: "17caf644602115465f3ef02204e2f67917bfe58d6089c10f77f94863e4c3bd87",
});
const proofRoot = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const currentKernelRoot = NodePath.resolve(proofRoot, "../../src/kernel");
const digest = (bytes: Uint8Array | string) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

function requiredPath(name: string, value: string | undefined): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Missing required input ${name}`);
  }
  return NodePath.resolve(value);
}

/** Packages the unchanged Codex release with the hook proof entry and pinned Bash bytes. */
export async function prepareCodexHooksProof(options: {
  readonly releaseDir: string;
  readonly bashPath: string;
  readonly kernelRoot?: string;
  readonly outputDir: string;
}) {
  if (options == null) throw new Error("Pass --release, --bash and --output");
  const releaseDir = requiredPath("--release", options.releaseDir);
  const bashPath = requiredPath("--bash", options.bashPath);
  const outputDir = requiredPath("--output", options.outputDir);
  const kernelRootInput =
    options.kernelRoot === undefined
      ? currentKernelRoot
      : requiredPath("--kernel-root", options.kernelRoot);
  const kernelRoot = await NodeFSP.realpath(kernelRootInput);
  const manifestBytes = await NodeFSP.readFile(NodePath.join(releaseDir, "manifest.json"));
  const manifestSha256 = digest(manifestBytes);
  if (manifestSha256 !== RELEASE_MANIFEST_SHA256) {
    throw new Error("Codex release manifest does not match the pinned 0.162.1 artifact");
  }

  const staging = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "1066-codex-hooks-entry-"));
  try {
    const source = [
      'import engine from "./engine.wasm";',
      'import bash from "./bash.wasm";',
      `import { createProofFacet } from ${JSON.stringify(NodePath.join(proofRoot, "../codexTurn/ProofFacet.mjs"))};`,
      `import { createCodexHooksProofClass } from ${JSON.stringify(NodePath.join(proofRoot, "CodexHooksProof.ts"))};`,
      "export class ProbeFacet extends createCodexHooksProofClass(engine, bash, createProofFacet) {}",
      'export default { fetch() { return new Response("Facet only"); } };',
    ].join("\n");
    const sourcePath = NodePath.join(staging, "codex-hooks-entry.mjs");
    await NodeFSP.writeFile(sourcePath, source);
    const bundled = await build({
      entryPoints: [sourcePath],
      bundle: true,
      write: false,
      metafile: true,
      format: "esm",
      platform: "neutral",
      target: "es2023",
      external: ["cloudflare:workers", "node:*", "./engine.wasm", "./bash.wasm"],
      plugins: [
        {
          name: "frozen-kernel",
          setup(builder) {
            builder.onResolve({ filter: /\.ts$/ }, (args) => {
              const resolved = NodePath.resolve(args.resolveDir, args.path);
              if (!resolved.startsWith(currentKernelRoot + NodePath.sep)) return undefined;
              return {
                path: NodePath.join(kernelRoot, NodePath.relative(currentKernelRoot, resolved)),
              };
            });
          },
        },
      ],
    });
    const entryModulePath = NodePath.join(staging, "worker.js");
    await NodeFSP.writeFile(entryModulePath, bundled.outputFiles[0]!.contents);
    const result = await createCodexFixture({
      artifactDir: releaseDir,
      expectedManifestSha256: RELEASE_MANIFEST_SHA256,
      entryModulePath,
      outputDir,
      id: "codex-hooks-official-proof",
      paths: ["/turn", "/turn"],
      additionalModules: {
        "bash.wasm": { path: bashPath, type: "wasm", ...BASH_ARTIFACT },
      },
    });

    const proofManifest = await enableProofBindings(outputDir);
    const sources = [];
    for (const name of Object.keys(bundled.metafile.inputs).sort()) {
      const absolute = NodePath.resolve(name);
      if (absolute === sourcePath) continue;
      const bytes = await NodeFSP.readFile(absolute);
      sources.push({ path: absolute, bytes: bytes.byteLength, sha256: digest(bytes) });
    }
    const preparerPath = NodeURL.fileURLToPath(import.meta.url);
    const preparerBytes = await NodeFSP.readFile(preparerPath);
    sources.push({
      path: preparerPath,
      bytes: preparerBytes.byteLength,
      sha256: digest(preparerBytes),
    });
    await NodeFSP.writeFile(
      NodePath.join(outputDir, "sourceInventory.json"),
      `${JSON.stringify({ kernelRoot, generatedEntrySha256: digest(source), sources }, null, 2)}\n`,
      { flag: "wx", mode: 0o444 },
    );
    return {
      ...result,
      manifest: proofManifest,
      manifestSha256,
      generatedCodeEnabled: true,
      childWorkersEnabled: true,
    };
  } finally {
    await NodeFSP.rm(staging, { recursive: true, force: true });
  }
}

async function enableProofBindings(outputDir: string): Promise<Record<string, unknown>> {
  const path = NodePath.join(outputDir, "manifest.json");
  await NodeFSP.chmod(path, 0o644);
  try {
    const parsed: unknown = JSON.parse(await NodeFSP.readFile(path, "utf8"));
    if (
      !isRecord(parsed) ||
      parsed.id !== "codex-hooks-official-proof" ||
      parsed.entrypoint !== "ProbeFacet"
    ) {
      throw new Error("Prepared Codex hook fixture has an unexpected manifest");
    }
    const proofManifest = { ...parsed, allowGeneratedCode: true, allowChildWorkers: true };
    await NodeFSP.writeFile(path, `${JSON.stringify(proofManifest, null, 2)}\n`);
    return proofManifest;
  } finally {
    await NodeFSP.chmod(path, 0o444);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  const { values } = NodeUtil.parseArgs({
    allowPositionals: false,
    options: {
      release: { type: "string" },
      bash: { type: "string" },
      "kernel-root": { type: "string" },
      output: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write(
      "Usage: prepareCodex.ts --release <dir> --bash <file> --output <dir> [--kernel-root <dir>]\n\n" +
        "Required inputs:\n" +
        "  --release <dir>       Pinned Codex 0.162.1 artifact directory\n" +
        "  --bash <file>         Pinned Bash wasm artifact\n" +
        "  --output <dir>        Fresh proof output directory\n" +
        "Optional inputs:\n" +
        "  --kernel-root <dir>   Kernel source root (defaults to this checkout)\n",
    );
  } else {
    const result = await prepareCodexHooksProof({
      releaseDir: requiredPath("--release", values.release),
      bashPath: requiredPath("--bash", values.bash),
      ...(values["kernel-root"] === undefined
        ? {}
        : { kernelRoot: requiredPath("--kernel-root", values["kernel-root"]) }),
      outputDir: requiredPath("--output", values.output),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
}
