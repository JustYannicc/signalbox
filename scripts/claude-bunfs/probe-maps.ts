// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - standalone Node fixture generation uses console for its CLI result.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { binaryHash } from "./releases.ts";
import {
  binarySha256,
  digest,
  probeModule,
  reachableSources,
  type SourceModule,
  type Encoding,
} from "./probe-sources.ts";

const targets = [10_000_000, 25_000_000, 45_000_000];

type Mode = "facet" | "worker";

function makeProbeSource(details: Record<string, unknown>, moduleToLoad: string) {
  const specifier =
    moduleToLoad.startsWith("/") || /^[A-Za-z]:[\\/]/.test(moduleToLoad)
      ? moduleToLoad
      : NodePath.posix.relative(NodePath.posix.dirname(probeModule), moduleToLoad);
  const importPath =
    specifier.startsWith(".") || specifier.startsWith("/") || /^[A-Za-z]:[\\/]/.test(specifier)
      ? specifier
      : `./${specifier}`;
  return `import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
const details = ${JSON.stringify(details)};
async function respond(request) {
  const path = new URL(request.url).pathname;
  if (path === "/status") {
    return Response.json({ measurement: "source-present-only", activeLoadAttempted: false, ...details });
  }
  if (path === "/active-load") {
    try {
      await import(${JSON.stringify(importPath)});
      return Response.json({ measurement: "active-load", attempted: true, ok: true, module: ${JSON.stringify(moduleToLoad)} });
    } catch (error) {
      return Response.json({
        measurement: "active-load",
        attempted: true,
        ok: false,
        module: ${JSON.stringify(moduleToLoad)},
        error: { name: error?.name ?? "Error", message: String(error?.message ?? error) },
      });
    }
  }
  return Response.json({ ok: false, error: { name: "NotFound", message: "Unknown probe path" } }, { status: 404 });
}
export class ProbeFacet extends DurableObject {
  fetch(request) { return respond(request); }
}
export class ProbeWorker extends WorkerEntrypoint {
  fetch(request) { return respond(request); }
}
export default {
  fetch(request) { return respond(request); },
};
`;
}

function selectModules(modules: SourceModule[], target: number) {
  const selected: SourceModule[] = [];
  let bytes = 0;
  for (const module of modules) {
    selected.push(module);
    bytes += module.bytes.byteLength;
    if (bytes >= target) break;
  }
  return { selected, bytes };
}

function makeMap(
  id: string,
  mode: Mode,
  selected: SourceModule[],
  target: number,
  bytes: number,
  verifiedBinary: boolean,
) {
  const mainModule = probeModule;
  const entrypoint = mode === "facet" ? "ProbeFacet" : "ProbeWorker";
  const details = {
    id,
    mode,
    release: "Claude Code 2.1.302",
    binarySha256,
    binaryVerified: verifiedBinary,
    targetSourceBytes: target,
    actualSourceBytes: bytes,
    sourceModuleCount: selected.length,
  };
  const probeSource = makeProbeSource(details, selected[0]!.name.replace(/^\/+/, ""));
  const modules: Record<string, { js: string }> = Object.fromEntries(
    selected.map((module) => [module.name.replace(/^\/+/, ""), { js: module.source }]),
  );
  modules[probeModule] = { js: probeSource };
  return {
    map: { id, mode, mainModule, entrypoint, modules },
    details: {
      ...details,
      mainModule,
      entrypoint,
      probeModule: {
        name: probeModule,
        bytes: Buffer.byteLength(probeSource, "utf8"),
        sha256: digest(Buffer.from(probeSource, "utf8")),
      },
      fixtureModuleCount: selected.length + 1,
      totalModuleBytesIncludingProbe: bytes + Buffer.byteLength(probeSource, "utf8"),
      selectedModules: selected.map((module) => ({
        name: module.name,
        actualBytes: module.bytes.byteLength,
        sha256: module.sha256,
        encoding: module.encoding,
      })),
    },
  };
}

async function writeFixture(
  dir: string,
  map: ReturnType<typeof makeMap>["map"],
  details: ReturnType<typeof makeMap>["details"],
) {
  const modulesDir = NodePath.join(dir, "modules");
  await NodeFSP.mkdir(modulesDir, { recursive: true });
  const fixtureModules: Record<
    string,
    {
      path: string;
      type: "js";
      actualBytes: number;
      sha256: string;
      sourceEncoding: Encoding;
      utf8FileBytes: number;
      originalEncoding?: Encoding;
      originalBytes?: number;
      originalSha256?: string;
    }
  > = {};
  const sourceMetadata = new Map(
    details.selectedModules.map((module) => [module.name.replace(/^\/+/, ""), module] as const),
  );
  for (const [name, module] of Object.entries(map.modules)) {
    const filename = `${digest(Buffer.from(name, "utf8")).slice(0, 24)}.js`;
    const path = `modules/${filename}`;
    await NodeFSP.writeFile(NodePath.join(dir, path), module.js, "utf8");
    const source = sourceMetadata.get(name);
    fixtureModules[name] = {
      path,
      type: "js",
      actualBytes: Buffer.byteLength(module.js, "utf8"),
      sha256: digest(Buffer.from(module.js, "utf8")),
      sourceEncoding: "utf8",
      ...(source
        ? {
            originalEncoding: source.encoding,
            originalBytes: source.actualBytes,
            originalSha256: source.sha256,
          }
        : {}),
      utf8FileBytes: Buffer.byteLength(module.js, "utf8"),
    };
  }
  await NodeFSP.writeFile(
    NodePath.join(dir, "manifest.json"),
    `${JSON.stringify(
      {
        id: map.id,
        mode: map.mode,
        mainModule: map.mainModule,
        entrypoint: map.entrypoint,
        modules: fixtureModules,
        paths: ["/status"],
        binarySha256: details.binarySha256,
        binaryVerified: details.binaryVerified,
        targetSourceBytes: details.targetSourceBytes,
        actualSourceBytes: details.actualSourceBytes,
        sourceModuleCount: details.sourceModuleCount,
        totalModuleBytesIncludingProbe: details.totalModuleBytesIncludingProbe,
      },
      null,
      2,
    )}\n`,
  );
}

function parseArgs(args: string[]) {
  const positional: string[] = [];
  let manifest: string | undefined;
  let binary: string | undefined;
  let mode: Mode = "facet";
  for (let at = 0; at < args.length; at++) {
    const value = args[at]!;
    if (value === "--manifest") manifest = args[++at];
    else if (value === "--binary") binary = args[++at];
    else if (value === "--mode") {
      const candidate = args[++at];
      if (candidate !== "facet" && candidate !== "worker")
        throw new Error("--mode must be facet or worker");
      mode = candidate;
    } else if (value.startsWith("--")) throw new Error(`Unknown option: ${value}`);
    else positional.push(value);
  }
  if (positional.length !== 2) {
    throw new Error(
      "Usage: node scripts/claude-bunfs/probe-maps.ts <extracted-dir> <output-dir> [--manifest path] [--binary path] [--mode facet|worker]",
    );
  }
  return {
    root: NodePath.resolve(positional[0]!),
    output: NodePath.resolve(positional[1]!),
    manifest,
    binary,
    mode,
  };
}

export async function generateProbeMaps(args: string[]) {
  const options = parseArgs(args);
  const manifestPath = options.manifest
    ? NodePath.resolve(options.manifest)
    : NodePath.join(options.root, "manifest.json");
  let verifiedBinary = false;
  if (options.binary) {
    const actual = await binaryHash(NodePath.resolve(options.binary));
    if (actual !== binarySha256)
      throw new Error(`Binary SHA-256 mismatch: expected ${binarySha256}, got ${actual}`);
    verifiedBinary = true;
  }
  const modules = await reachableSources(options.root, manifestPath, options.output);
  await NodeFSP.mkdir(options.output, { recursive: true });
  const summaries = [];
  for (const target of targets) {
    const { selected, bytes } = selectModules(modules, target);
    const label = `${target / 1_000_000}mb`;
    const id = `claude-2-1-302-${label}-${options.mode}`;
    const { map, details } = makeMap(id, options.mode, selected, target, bytes, verifiedBinary);
    const mapPath = NodePath.join(options.output, `${id}.json`);
    const metadataPath = NodePath.join(options.output, `${id}.metadata.json`);
    const fixturePath = NodePath.join(options.output, id);
    await NodeFSP.writeFile(mapPath, `${JSON.stringify(map)}\n`);
    await NodeFSP.writeFile(metadataPath, `${JSON.stringify(details, null, 2)}\n`);
    await writeFixture(fixturePath, map, details);
    summaries.push({
      id,
      targetBytes: target,
      actualSourceBytes: bytes,
      sourceModuleCount: selected.length,
      mapPath,
      metadataPath,
      fixturePath,
    });
  }
  return {
    binarySha256,
    binaryVerified: verifiedBinary,
    sourceModuleCount: modules.length,
    totalAvailableSourceBytes: modules.reduce(
      (total, module) => total + module.bytes.byteLength,
      0,
    ),
    maps: summaries,
  };
}

if (
  process.argv[1] &&
  import.meta.url === NodeURL.pathToFileURL(NodePath.resolve(process.argv[1])).href
) {
  const result = await generateProbeMaps(process.argv.slice(2));
  console.log(JSON.stringify(result, null, 2));
}
