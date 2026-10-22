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
import { readPublishedBuiltinSources } from "./nodeBuiltinGate/published.ts";

export { scanBuiltinSource } from "./nodeBuiltinGate/source.ts";
export type { BuiltinSource } from "./nodeBuiltinGate/source.ts";

/** Runs before publication, including when provider components came from a build cache. */
export async function assertPackagedBuiltinCoverage(
  sources: readonly BuiltinSource[],
  runtimeInventory?: RuntimeBuiltinInventory,
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
  assertNodeBuiltinCoverage(report);
  return {
    ...report,
    runtimeProfile: installed.profile,
    ...(installed.capture === undefined ? {} : { runtimeCapture: installed.capture }),
    sources: inventory,
  };
}

/** Validates and scans exactly the JavaScript declared in the final bundle manifest. */
export async function assertPublishedBuiltinCoverage(
  directory: string,
  runtimeInventory?: RuntimeBuiltinInventory,
) {
  const { sources, artifact, omission } = await readPublishedBuiltinSources(directory);
  return {
    ...(await assertPackagedBuiltinCoverage(sources, runtimeInventory)),
    artifact,
    ...(omission === undefined ? {} : { omission }),
  };
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
  return assertPackagedBuiltinCoverage(sources);
}
