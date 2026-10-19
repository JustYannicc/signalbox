import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { build } from "esbuild";
import { createCodexFixture } from "./fixturePackager.mjs";

const digest = (bytes) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const proofRoot = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const currentKernelRoot = NodePath.resolve(proofRoot, "../../src/kernel");
const bashArtifact = Object.freeze({
  bytes: 3_887_571,
  sha256: "17caf644602115465f3ef02204e2f67917bfe58d6089c10f77f94863e4c3bd87",
});

/** Packages static modules without executing or recompiling the official engine. */
export async function prepareTurnFixture({
  artifactDir,
  expectedManifestSha256,
  kernelRoot = currentKernelRoot,
  outputDir,
  mode = "startup",
  bashPath,
}) {
  if (mode !== "startup" && mode !== "turn") throw new Error("Choose startup or turn mode");
  if (mode === "turn" && !bashPath)
    throw new Error("Turn proof requires the pinned GNU Bash module");
  const frozenKernelRoot = await NodeFSP.realpath(kernelRoot);
  const destination = NodePath.resolve(outputDir);
  const staging = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "1069-static-entry-"));
  try {
    const source = [
      'import engine from "./engine.wasm";',
      `import { createProofFacet } from ${JSON.stringify(NodePath.join(proofRoot, "ProofFacet.mjs"))};`,
      ...(mode === "turn"
        ? [
            'import bash from "./bash.wasm";',
            `import { createProofBashHost } from ${JSON.stringify(NodePath.join(proofRoot, "BashPrograms.mjs"))};`,
          ]
        : []),
      `export class ProbeFacet extends createProofFacet(engine${mode === "turn" ? ", (wakes) => createProofBashHost(bash, wakes)" : ""}) {}`,
      'export default { fetch() { return new Response("Facet only"); } };',
    ].join("\n");
    const bundled = await build({
      stdin: { contents: source, resolveDir: proofRoot, sourcefile: "codex-proof-entry.mjs" },
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
                path: NodePath.join(
                  frozenKernelRoot,
                  NodePath.relative(currentKernelRoot, resolved),
                ),
              };
            });
          },
        },
      ],
    });
    const entryModulePath = NodePath.join(staging, "worker.js");
    await NodeFSP.writeFile(entryModulePath, bundled.outputFiles[0].contents);
    const result = await createCodexFixture({
      artifactDir,
      expectedManifestSha256,
      entryModulePath,
      outputDir: destination,
      id: NodePath.basename(destination),
      paths: mode === "turn" ? ["/turn", "/turn"] : ["/startup"],
      additionalModules:
        mode === "turn"
          ? {
              "bash.wasm": { path: bashPath, type: "wasm", ...bashArtifact },
            }
          : {},
    });
    const sources = [];
    for (const name of Object.keys(bundled.metafile.inputs).sort()) {
      const absolute = NodePath.resolve(name);
      if (absolute === NodePath.join(proofRoot, "codex-proof-entry.mjs")) continue;
      const bytes = await NodeFSP.readFile(absolute);
      sources.push({ path: absolute, bytes: bytes.length, sha256: digest(bytes) });
    }
    const preparation = await NodeFSP.readFile(NodeURL.fileURLToPath(import.meta.url));
    sources.push({
      path: NodeURL.fileURLToPath(import.meta.url),
      bytes: preparation.length,
      sha256: digest(preparation),
    });
    await NodeFSP.writeFile(
      NodePath.join(destination, "sourceInventory.json"),
      JSON.stringify(
        {
          kernelRoot: frozenKernelRoot,
          mode,
          generatedEntrySha256: digest(source),
          sources,
        },
        null,
        2,
      ) + "\n",
      { flag: "wx", mode: 0o444 },
    );
    return result;
  } finally {
    await NodeFSP.rm(staging, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  const [artifactDir, expectedManifestSha256, kernelRoot, outputDir, mode, bashPath] =
    process.argv.slice(2);
  if (!artifactDir || !expectedManifestSha256 || !kernelRoot || !outputDir) {
    throw new Error(
      "Pass artifact directory, manifest SHA-256, frozen kernel directory, output directory, startup|turn, and optional Bash path",
    );
  }
  const result = await prepareTurnFixture({
    artifactDir,
    expectedManifestSha256,
    kernelRoot,
    outputDir,
    mode,
    bashPath,
  });
  process.stdout.write(JSON.stringify(result.inventory, null, 2) + "\n");
}
