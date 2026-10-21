import * as NodeModule from "node:module";
import {
  assertNodeBuiltinCoverage,
  inspectNodeBuiltinCoverage,
  nodeBuiltinProviderSpecifiers,
  type NodeBuiltinAmbiguity,
} from "./nodeBuiltinGate/coverage.ts";
import { captureRuntimeBuiltinSpecifiers } from "./runtimeBuiltinInventory.ts";
import { scanBuiltinSource, type BuiltinSource } from "./nodeBuiltinGate/source.ts";

export { scanBuiltinSource } from "./nodeBuiltinGate/source.ts";
export type { BuiltinSource } from "./nodeBuiltinGate/source.ts";

export function inspectInstalledBuiltinSources(
  sources: readonly BuiltinSource[],
  installed: Readonly<Record<string, object>>,
) {
  const inventory = sources.map(scanBuiltinSource);
  const coverage = inspectNodeBuiltinCoverage({
    builtinModules: NodeModule.builtinModules,
    requiredSpecifiers: inventory.flatMap((entry) => entry.requiredSpecifiers),
    installedSpecifiers: nodeBuiltinProviderSpecifiers(installed, NodeModule.builtinModules),
    ambiguities: inventory.flatMap((entry) => entry.ambiguities),
  });
  return { ...coverage, sources: inventory };
}

/** Runs before publication, including when the provider components came from a build cache. */
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

export async function assertReleaseBuiltinCoverage(input: {
  readonly requiredSpecifiers: readonly string[];
  readonly ambiguities: readonly NodeBuiltinAmbiguity[];
}) {
  const installed = await captureRuntimeBuiltinSpecifiers();
  const report = inspectNodeBuiltinCoverage({
    builtinModules: NodeModule.builtinModules,
    ...input,
    installedSpecifiers: installed,
  });
  assertNodeBuiltinCoverage(report);
  return report;
}
