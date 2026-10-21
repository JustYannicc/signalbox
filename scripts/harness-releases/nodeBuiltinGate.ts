import * as NodeModule from "node:module";
import { readExtraction } from "../claude-bunfs/extracted-input.ts";
import {
  assertNodeBuiltinCoverage,
  inspectNodeBuiltinCoverage,
} from "./nodeBuiltinGate/coverage.ts";
import { captureRuntimeBuiltinSpecifiers } from "./runtimeBuiltinInventory.ts";
import { scanBuiltinSource, type BuiltinSource } from "./nodeBuiltinGate/source.ts";

export { scanBuiltinSource } from "./nodeBuiltinGate/source.ts";
export type { BuiltinSource } from "./nodeBuiltinGate/source.ts";

/** Runs before publication, including when provider components came from a build cache. */
export async function assertPackagedBuiltinCoverage(sources: readonly BuiltinSource[]) {
  const installed = await captureRuntimeBuiltinSpecifiers();
  const inventory = sources.map(scanBuiltinSource);
  const report = inspectNodeBuiltinCoverage({
    builtinModules: NodeModule.builtinModules,
    requiredSpecifiers: inventory.flatMap((entry) => entry.requiredSpecifiers),
    installedSpecifiers: installed,
    ambiguities: inventory.flatMap((entry) => entry.ambiguities),
  });
  assertNodeBuiltinCoverage(report);
  return { ...report, sources: inventory };
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
