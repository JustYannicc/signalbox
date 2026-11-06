import type { ClaudeReleasePlan } from "../../../../src/harness/HarnessReleasePlan.ts";
export type ClaudePreparedPlan = Pick<
  ClaudeReleasePlan,
  "preparedModules" | "environmentPackageModules" | "initialize" | "main"
> & {
  readonly cli: Pick<ClaudeReleasePlan["cli"], "version">;
  readonly sdk: Pick<ClaudeReleasePlan["sdk"], "version">;
};

export type ClaudePreparedModuleImporter = (specifier: string) => Promise<unknown>;
const MODULE_PREFIX = "claude-prepared";
const environmentPackages = new Set(["undici", "yaml", "ws", "node-fetch", "bun:jsc"]);
function assertModulePath(path: string): void {
  if (
    path.length === 0 ||
    path.includes("\\") ||
    path.startsWith("/") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  )
    throw new TypeError("Claude prepared module path is invalid.");
}

export function claudePreparedModuleName(moduleKey: string): string {
  assertModulePath(moduleKey);
  return `${MODULE_PREFIX}/${moduleKey}`;
}

export function claudePreparedModuleSpecifier(moduleKey: string): string {
  return `./${claudePreparedModuleName(moduleKey)}`;
}

function packageSegment(packageName: string): string {
  if (!environmentPackages.has(packageName))
    throw new TypeError(`Unsupported Claude environment package: ${packageName}`);
  return Array.from(new TextEncoder().encode(packageName), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function claudeEnvironmentPackageModuleName(packageName: string): string {
  return `${MODULE_PREFIX}/environment/${packageSegment(packageName)}.mjs`;
}

export function claudeEnvironmentPackageModuleSpecifier(packageName: string): string {
  return `./${claudeEnvironmentPackageModuleName(packageName)}`;
}
