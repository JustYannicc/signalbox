import { preparedReleaseAsset } from "../../../../src/harness/HarnessProcessPlacement.ts";
import type {
  HarnessProcessFacetModule,
  HarnessProcessPreparedRelease,
} from "../../../../src/harness/HarnessProcessPlacement.ts";

import type { ClaudePreparedPlan } from "./claudePreparedNames.ts";
export type { ClaudePreparedPlan, ClaudePreparedModuleImporter } from "./claudePreparedNames.ts";

export interface ClaudePreparedRelease extends HarnessProcessPreparedRelease {
  readonly plan: HarnessProcessPreparedRelease["plan"] & ClaudePreparedPlan;
}

export type ClaudeEnvironmentPackageSources = Readonly<Record<string, string>>;

export {
  claudePreparedModuleName,
  claudePreparedModuleSpecifier,
  claudeEnvironmentPackageModuleName,
  claudeEnvironmentPackageModuleSpecifier,
} from "./claudePreparedNames.ts";
import {
  claudePreparedModuleName,
  claudeEnvironmentPackageModuleName,
} from "./claudePreparedNames.ts";
/** Uses the public range-checked asset descriptor; no JS module source is copied into config. */
export async function claudePreparedWorkerModules(
  release: ClaudePreparedRelease,
  environmentSources: ClaudeEnvironmentPackageSources,
  component?: "cli" | "sdk",
): Promise<Readonly<Record<string, HarnessProcessFacetModule>>> {
  const modules: Record<string, HarnessProcessFacetModule> = Object.create(null);
  for (const moduleKey of Object.keys(release.plan.preparedModules).filter(
    (key) => component === undefined || release.plan.preparedModules[key]?.component === component,
  ))
    modules[claudePreparedModuleName(moduleKey)] = preparedReleaseAsset(release, moduleKey);

  const packageNames = Object.keys(release.plan.environmentPackageModules).sort();
  const sourceNames = Object.keys(environmentSources).sort();
  if (packageNames.join("\0") !== sourceNames.join("\0"))
    throw new Error("CLAUDE_ENVIRONMENT_PACKAGE_SET_MISMATCH");
  for (const packageName of packageNames) {
    const source = environmentSources[packageName];
    const pin = release.plan.environmentPackageModules[packageName];
    if (source === undefined || pin === undefined)
      throw new Error("CLAUDE_ENVIRONMENT_PACKAGE_MISSING");
    const bytes = new TextEncoder().encode(source);
    if (bytes.byteLength !== pin.bytes || (await sha256(source)) !== pin.sha256)
      throw new Error(`CLAUDE_ENVIRONMENT_PACKAGE_PIN_MISMATCH: ${packageName}`);
    modules[claudeEnvironmentPackageModuleName(packageName)] = { js: source };
  }
  return Object.freeze(modules);
}

export { createClaudePreparedImports } from "./claudePreparedImports.ts";

async function sha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
