import * as NodeModule from "node:module";
import { readExtraction } from "../claude-bunfs/extracted-input.ts";
import {
  assertNodeBuiltinCoverage,
  inspectNodeBuiltinCoverage,
} from "./nodeBuiltinGate/coverage.ts";
import {
  captureRuntimeBuiltinInventory,
  type RuntimeBuiltinInventory,
} from "./runtimeBuiltinInventory.ts";
import { scanBuiltinSource, type BuiltinSource } from "./nodeBuiltinGate/source.ts";
import { linkPublishedSources } from "./nodeBuiltinGate/publishedGraph.ts";
import { readPublishedBuiltinSources } from "./nodeBuiltinGate/published.ts";
import {
  assessNodeBuiltinReachability,
  createNodeBuiltinReachabilityInventory,
  type BuiltinReachabilityCorpus,
  type NodeBuiltinReachabilityAssessment,
  type NodeBuiltinReachabilityInventory,
} from "./nodeBuiltinGate/reachability.ts";

export { scanBuiltinSource } from "./nodeBuiltinGate/source.ts";
export type { BuiltinSource } from "./nodeBuiltinGate/source.ts";
export {
  assessNodeBuiltinReachability,
  type BuiltinReachabilityCorpus,
  type NodeBuiltinReachabilityAssessment,
  type NodeBuiltinReachabilityInventory,
};

/** Runs before publication, including when provider components came from a build cache. */
export async function inspectPackagedBuiltinCoverage(
  sources: readonly BuiltinSource[],
  runtimeInventory?: RuntimeBuiltinInventory,
  reachabilitySources: readonly BuiltinSource[] = sources,
) {
  const inventory = sources.map(scanBuiltinSource);
  const requiredFunctions = inventory.flatMap((entry) => entry.requiredFunctions);
  const installed = runtimeInventory ?? (await captureRuntimeBuiltinInventory(requiredFunctions));
  const report = inspectNodeBuiltinCoverage({
    builtinModules: NodeModule.builtinModules,
    requiredSpecifiers: inventory.flatMap((entry) => entry.requiredSpecifiers),
    installedSpecifiers: installed.modules,
    functionCapabilities: installed.functions,
    requiredFunctions,
    ambiguities: inventory.flatMap((entry) => entry.ambiguities),
    functionAmbiguities: inventory.flatMap((entry) => entry.functionAmbiguities),
  });
  const sourceByName = new Map(inventory.map((source) => [source.name, source]));
  const sourceInventory = reachabilitySources.map((source) => {
    const scanned = sourceByName.get(source.name);
    if (!scanned) throw new Error("NODE_BUILTIN_REACHABILITY_SOURCE_BINDING_MISMATCH");
    return scanned;
  });
  return {
    ...report,
    reachabilityInventory: createNodeBuiltinReachabilityInventory(
      report,
      sourceInventory,
      inventory,
    ),
    runtimeProfile: installed.profile,
    ...(installed.capture === undefined ? {} : { runtimeCapture: installed.capture }),
    sources: inventory,
  };
}

export async function assertPackagedBuiltinCoverage(
  sources: readonly BuiltinSource[],
  runtimeInventory?: RuntimeBuiltinInventory,
  reachabilitySources: readonly BuiltinSource[] = sources,
) {
  const inspected = await inspectPackagedBuiltinCoverage(
    sources,
    runtimeInventory,
    reachabilitySources,
  );
  assertNodeBuiltinCoverage(inspected);
  return inspected;
}

/** Validates and scans exactly the JavaScript declared in the final bundle manifest. */
export async function inspectPublishedBuiltinCoverage(
  directory: string,
  runtimeInventory?: RuntimeBuiltinInventory,
) {
  const { sources, artifact, omission, partitioned } = await readPublishedBuiltinSources(directory);
  const analysisSources = partitioned ? [...sources, await linkPublishedSources(sources)] : sources;
  const scanned = await inspectPackagedBuiltinCoverage(analysisSources, runtimeInventory, sources);
  return {
    ...scanned,
    artifact,
    ...(omission === undefined ? {} : { omission }),
  };
}

export async function assertPublishedBuiltinCoverage(
  directory: string,
  runtimeInventory?: RuntimeBuiltinInventory,
  reachabilityCorpus?: BuiltinReachabilityCorpus,
) {
  const inspected = await inspectPublishedBuiltinCoverage(directory, runtimeInventory);
  assertNodeBuiltinCoverage(inspected);
  const reachability = assessNodeBuiltinReachability({
    artifactSha256: inspected.artifact.sha256,
    inventory: inspected.reachabilityInventory,
    ...(reachabilityCorpus === undefined ? {} : { corpus: reachabilityCorpus }),
  });
  if (reachability.coverageStatus === "rejected")
    throw new Error(`NODE_BUILTIN_REACHABILITY_FAILED: ${reachability.blockers.join("; ")}`);
  return { ...inspected, reachability };
}

/** Original extracted code and packaged code share the same builtin-name analysis. */
export async function assertExtractedBuiltinCoverage(directory: string) {
  const extraction = await readExtraction(directory);
  const sources: BuiltinSource[] = [];
  for (const module of extraction.manifest.modules) {
    if (module.loader !== 1) continue;
    sources.push({
      name: module.name,
      source: await extraction.readSource(module),
      format: module.format,
    });
  }
  const coverage = await assertPackagedBuiltinCoverage(sources);
  return {
    ...coverage,
    sourceArtifactSha256: extraction.manifest.binary.sha256,
  };
}

/** Produces exact-source callsite offsets for offline joins with V8 range evidence. */
export async function scanExtractedBuiltinSources(directory: string) {
  const extraction = await readExtraction(directory);
  const sources: BuiltinSource[] = [];
  for (const module of extraction.manifest.modules) {
    if (module.loader !== 1) continue;
    sources.push({
      name: module.name,
      source: await extraction.readSource(module),
      format: module.format,
    });
  }
  const inventory = sources.map(scanBuiltinSource);
  return {
    sourceArtifactSha256: extraction.manifest.binary.sha256,
    sources: inventory.map((source) => {
      const module = extraction.manifest.modules.find((item) => item.name === source.name);
      const payloadSha256 = module?.artifacts.contents?.sha256;
      if (!payloadSha256) throw new Error("NODE_BUILTIN_SOURCE_PAYLOAD_PIN_MISSING");
      return {
        name: source.name,
        bytes: source.bytes,
        sha256: source.sha256,
        sourceUtf16Length: source.sourceUtf16Length,
        payloadSha256,
        requiredSpecifiers: source.requiredSpecifiers,
        ambiguities: source.ambiguities,
        requiredFunctions: source.requiredFunctions,
        functionAmbiguities: source.functionAmbiguities,
      };
    }),
  };
}
