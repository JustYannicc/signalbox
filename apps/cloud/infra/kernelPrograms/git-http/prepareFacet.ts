// @effect-diagnostics nodeBuiltinImport:off - build-time packaging of the static Git proof facet.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Esbuild from "esbuild";
import { KERNEL_GIT_ARTIFACT } from "../../../src/kernel/KernelGitProgram.ts";
import { KERNEL_GIT_HTTP_FACET_SOURCE } from "./facet-source.ts";

const SOURCE_MARKER = "__KERNEL_GIT_HTTP_SOURCE_INVENTORY__";
const scriptDir = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const digest = (bytes: Uint8Array | string) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

interface SourceRecord {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export async function prepareKernelGitHttpFacet(
  destination: string,
  revision: string,
  wasmPath = NodeURL.fileURLToPath(new URL("../git/git.wasm", import.meta.url)),
  sourceRoot = NodeURL.fileURLToPath(new URL("../../../", import.meta.url)),
) {
  if (!/^[0-9a-f]{40}$/.test(revision)) {
    throw new Error("Pass the exact 40-character source commit");
  }
  const cloudRoot = NodePath.resolve(sourceRoot);
  const outputDir = NodePath.resolve(destination);
  const wasm = await NodeFSP.readFile(wasmPath);
  if (
    wasm.byteLength !== KERNEL_GIT_ARTIFACT.bytes ||
    digest(wasm) !== KERNEL_GIT_ARTIFACT.sha256
  ) {
    throw new Error("Git WASM does not match its frozen source pin");
  }

  const provenance = JSON.parse(
    await NodeFSP.readFile(NodePath.join(scriptDir, "provenance.json"), "utf8"),
  ) as {
    readonly importAlias: string;
    readonly package: {
      readonly name: string;
      readonly version: string;
      readonly gitHead: string;
      readonly repository: string;
      readonly license: string;
      readonly integrity: string;
    };
  };
  const npmEntry = NodeURL.fileURLToPath(import.meta.resolve("isomorphic-git"));
  const packageRoot = NodePath.dirname(npmEntry);
  const npmManifest = JSON.parse(
    await NodeFSP.readFile(NodePath.join(packageRoot, "package.json"), "utf8"),
  ) as { readonly name: string; readonly version: string; readonly license: string };
  const lockfile = await NodeFSP.readFile(
    NodePath.resolve(cloudRoot, "../../pnpm-lock.yaml"),
    "utf8",
  );
  if (
    provenance.importAlias !== "isomorphic-git" ||
    provenance.package.name !== npmManifest.name ||
    provenance.package.version !== npmManifest.version ||
    provenance.package.license !== npmManifest.license ||
    !lockfile.includes(provenance.package.integrity)
  ) {
    throw new Error("The Git HTTP dependency no longer matches its recorded provenance");
  }
  const packageLicense = await NodeFSP.readFile(NodePath.join(packageRoot, "LICENSE.md"));
  const checkedInLicense = await NodeFSP.readFile(NodePath.join(scriptDir, "LICENSE.cf-git.md"));
  if (!packageLicense.equals(checkedInLicense)) {
    throw new Error("The checked-in cf-git license differs from the pinned package license");
  }

  const build = await Esbuild.build({
    absWorkingDir: cloudRoot,
    stdin: {
      contents: KERNEL_GIT_HTTP_FACET_SOURCE,
      resolveDir: scriptDir,
      sourcefile: "kernel-git-http-facet-entry.ts",
      loader: "ts",
    },
    bundle: true,
    write: false,
    metafile: true,
    format: "esm",
    platform: "neutral",
    mainFields: ["module", "main"],
    alias: { crypto: "node:crypto" },
    target: "es2023",
    external: ["cloudflare:workers", "node:*", "./git.wasm"],
  });
  const sources = await Promise.all(
    Object.keys(build.metafile.inputs)
      .filter((path) => path !== "kernel-git-http-facet-entry.ts")
      .sort()
      .map(async (path) => sourceRecord(cloudRoot, path)),
  );
  sources.push(
    await sourceRecord(cloudRoot, "infra/kernelPrograms/git-http/facet-source.ts"),
    await sourceRecord(cloudRoot, "infra/kernelPrograms/git-http/prepareFacet.ts"),
    await sourceRecord(cloudRoot, "infra/kernelPrograms/git-http/provenance.json"),
    await sourceRecord(cloudRoot, "infra/kernelPrograms/git-http/LICENSE.cf-git.md"),
    await sourceRecord(cloudRoot, "infra/kernelPrograms/git/COPYING"),
    await sourceRecord(cloudRoot, "infra/kernelPrograms/git/LICENSE-NIMBUS"),
  );
  sources.sort((left, right) => left.path.localeCompare(right.path));

  const bundle = build.outputFiles[0]?.text;
  if (bundle === undefined || !bundle.includes(JSON.stringify(SOURCE_MARKER))) {
    throw new Error("Git HTTP facet bundle lost its source inventory marker");
  }
  const main = bundle.replace(
    JSON.stringify(SOURCE_MARKER),
    JSON.stringify({ revision, files: sources }),
  );
  if (
    !/import\s+gitWasm\s+from\s+["']\.\/git\.wasm["']/.test(main) ||
    /\beval\s*\(|new\s+Function\s*\(|WebAssembly\.(?:Module|compile)\s*\(/.test(main)
  ) {
    throw new Error(
      "Git HTTP facet must keep the Cgit WASM static and avoid runtime code generation",
    );
  }

  await NodeFSP.mkdir(outputDir, { recursive: true });
  const modules = [
    { name: "main.js", type: "js", bytes: Buffer.byteLength(main), sha256: digest(main) },
    { name: "git.wasm", type: "wasm", bytes: wasm.byteLength, sha256: digest(wasm) },
  ];
  const inventory = {
    sourceRevision: revision,
    isomorphicGit: provenance,
    cgit: KERNEL_GIT_ARTIFACT,
    sources,
    modules,
  };
  const manifest = {
    id: "kernel-git-http-proof-v1",
    sourceRevision: revision,
    mainModule: "main.js",
    entrypoint: "KernelGitHttpFacet",
    mode: "facet",
    allowOutbound: false,
    modules: {
      "main.js": { path: "main.js", type: "js" },
      "git.wasm": { path: "git.wasm", type: "wasm" },
    },
    paths: ["/proof", "/proof-again"],
  };
  const provenanceOutput = {
    ...provenance,
    cgitArtifact: {
      ...KERNEL_GIT_ARTIFACT,
      licenseFiles: ["COPYING.cgit", "LICENSE-NIMBUS"],
    },
    sourceRevision: revision,
    build: {
      builder: "infra/kernelPrograms/git-http/prepareFacet.ts",
      module: modules[0],
      cgitModule: modules[1],
    },
  };
  await Promise.all([
    NodeFSP.writeFile(NodePath.join(outputDir, "main.js"), main),
    NodeFSP.writeFile(NodePath.join(outputDir, "git.wasm"), wasm),
    NodeFSP.writeFile(
      NodePath.join(outputDir, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    ),
    NodeFSP.writeFile(
      NodePath.join(outputDir, "inventory.json"),
      `${JSON.stringify(inventory, null, 2)}\n`,
    ),
    NodeFSP.writeFile(
      NodePath.join(outputDir, "provenance.json"),
      `${JSON.stringify(provenanceOutput, null, 2)}\n`,
    ),
    NodeFSP.copyFile(
      NodePath.join(scriptDir, "LICENSE.cf-git.md"),
      NodePath.join(outputDir, "LICENSE.cf-git.md"),
    ),
    NodeFSP.copyFile(
      NodePath.resolve(cloudRoot, "infra/kernelPrograms/git/COPYING"),
      NodePath.join(outputDir, "COPYING.cgit"),
    ),
    NodeFSP.copyFile(
      NodePath.resolve(cloudRoot, "infra/kernelPrograms/git/LICENSE-NIMBUS"),
      NodePath.join(outputDir, "LICENSE-NIMBUS"),
    ),
  ]);
  return inventory;
}

async function sourceRecord(root: string, path: string): Promise<SourceRecord> {
  const absolutePath = NodePath.resolve(root, path);
  const relativePath = NodePath.relative(root, absolutePath);
  const isOutsideRoot = relativePath === ".." || relativePath.startsWith(`..${NodePath.sep}`);
  const sourcePath = isOutsideRoot
    ? await dependencySourcePath(absolutePath)
    : relativePath.split(NodePath.sep).join("/");
  const contents = await NodeFSP.readFile(absolutePath);
  return { path: sourcePath, bytes: contents.byteLength, sha256: digest(contents) };
}

async function dependencySourcePath(absolutePath: string): Promise<string> {
  const marker = `${NodePath.sep}node_modules${NodePath.sep}`;
  const markerIndex = absolutePath.lastIndexOf(marker);
  if (markerIndex < 0)
    throw new Error(`Static Git facet input escaped its source root: ${absolutePath}`);

  const packageParts = absolutePath.slice(markerIndex + marker.length).split(NodePath.sep);
  const packagePartCount = packageParts[0]?.startsWith("@") ? 2 : 1;
  const packageRoot = NodePath.join(
    absolutePath.slice(0, markerIndex + marker.length),
    ...packageParts.slice(0, packagePartCount),
  );
  const metadata = JSON.parse(
    await NodeFSP.readFile(NodePath.join(packageRoot, "package.json"), "utf8"),
  ) as {
    readonly name: string;
    readonly version: string;
  };
  const packageFile = packageParts.slice(packagePartCount).join("/");
  return `npm/${metadata.name}@${metadata.version}/${packageFile}`;
}

if (process.argv[1] === NodeURL.fileURLToPath(import.meta.url)) {
  const destination = process.argv[2];
  const revision = process.argv[3];
  const wasmPath = process.argv[4];
  const sourceRoot = process.argv[5];
  if (!destination || !revision) {
    throw new Error(
      "Pass a destination and exact source commit (plus optional Cgit WASM path and cloud source root)",
    );
  }
  const inventory = await prepareKernelGitHttpFacet(
    NodePath.resolve(destination),
    revision,
    wasmPath === undefined ? undefined : NodePath.resolve(wasmPath),
    sourceRoot === undefined ? undefined : NodePath.resolve(sourceRoot),
  );
  process.stdout.write(
    `${JSON.stringify({ destination: NodePath.resolve(destination), inventory }, null, 2)}\n`,
  );
}
