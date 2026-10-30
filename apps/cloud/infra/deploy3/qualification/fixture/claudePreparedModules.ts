import { preparedReleaseAsset } from "../../../../src/harness/HarnessProcessPlacement.ts";
import type {
  HarnessProcessFacetModule,
  HarnessProcessPreparedRelease,
} from "../../../../src/harness/HarnessProcessPlacement.ts";
import type { ClaudeIsolateAdapterOptions } from "../../../../src/harness/ClaudeIsolateAdapter.ts";
import type { ClaudeReleasePlan } from "../../../../src/harness/HarnessReleasePlan.ts";
import type { PreparedClaudeSdk } from "../../../../src/harness/ClaudeIsolateAdapter.ts";

const MODULE_PREFIX = "claude-prepared";
const environmentPackages = new Set(["undici", "yaml", "ws", "node-fetch", "bun:jsc"]);

export type ClaudePreparedPlan = Pick<
  ClaudeReleasePlan,
  "preparedModules" | "environmentPackageModules" | "initialize" | "main"
> & {
  readonly cli: Pick<ClaudeReleasePlan["cli"], "version">;
  readonly sdk: Pick<ClaudeReleasePlan["sdk"], "version">;
};

export interface ClaudePreparedRelease extends HarnessProcessPreparedRelease {
  readonly plan: HarnessProcessPreparedRelease["plan"] & ClaudePreparedPlan;
}

export type ClaudeEnvironmentPackageSources = Readonly<Record<string, string>>;
type PackageBindings = Awaited<ReturnType<ClaudeIsolateAdapterOptions["process"]["loadPackages"]>>;
export type ClaudePreparedModuleImporter = (specifier: string) => Promise<unknown>;

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

async function sha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Uses the public range-checked asset descriptor; no JS module source is copied into config. */
export async function claudePreparedWorkerModules(
  release: ClaudePreparedRelease,
  environmentSources: ClaudeEnvironmentPackageSources,
): Promise<Readonly<Record<string, HarnessProcessFacetModule>>> {
  const modules: Record<string, HarnessProcessFacetModule> = Object.create(null);
  for (const moduleKey of Object.keys(release.plan.preparedModules))
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

async function importWorkerModule(specifier: string): Promise<unknown> {
  return await import(/* @vite-ignore */ specifier);
}

function record(value: unknown, description: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`Prepared Claude ${description} module has no exports.`);
  return value as Record<string, unknown>;
}

function requiredFunction(value: Record<string, unknown>, name: string, description: string) {
  const member = value[name];
  if (typeof member !== "function")
    throw new TypeError(`Prepared Claude ${description} module has no ${name} export.`);
  return member;
}

export function createClaudePreparedImports(
  importModule: ClaudePreparedModuleImporter = importWorkerModule,
) {
  const importModuleKey = (moduleKey: string) =>
    importModule(claudePreparedModuleSpecifier(moduleKey));

  const loadSdk = async (
    plan: ClaudePreparedPlan,
    signal: AbortSignal,
  ): Promise<PreparedClaudeSdk> => {
    signal.throwIfAborted();
    const namespace = record(await importModuleKey(plan.initialize.module), "SDK");
    signal.throwIfAborted();
    const initialize = requiredFunction(namespace, plan.initialize.export, "SDK");
    const loaded = record(await Reflect.apply(initialize, undefined, []), "SDK exports");
    requiredFunction(loaded, "query", "SDK exports");
    requiredFunction(loaded, "forkSession", "SDK exports");
    requiredFunction(loaded, "getSubagentMessages", "SDK exports");
    return loaded as unknown as PreparedClaudeSdk;
  };

  const loadRelease = async (plan: ClaudePreparedPlan, signal: AbortSignal) => {
    signal.throwIfAborted();
    const loaded = record(await importModuleKey(plan.main.module), "CLI");
    signal.throwIfAborted();
    requiredFunction(loaded, plan.main.export, "CLI");
    return loaded;
  };

  const loadPackages = async (
    plan: ClaudePreparedPlan,
    signal: AbortSignal,
  ): Promise<PackageBindings> => {
    const packages: Record<string, object> = Object.create(null);
    for (const name of Object.keys(plan.environmentPackageModules).sort()) {
      signal.throwIfAborted();
      if (!environmentPackages.has(name))
        throw new TypeError(`Unsupported Claude environment package: ${name}`);
      const namespace = record(
        await importModule(claudeEnvironmentPackageModuleSpecifier(name)),
        `environment package ${name}`,
      );
      const defaultExport = namespace.default;
      packages[name] =
        (typeof defaultExport === "object" && defaultExport !== null) ||
        typeof defaultExport === "function"
          ? (defaultExport as object)
          : namespace;
    }
    signal.throwIfAborted();
    return packages as PackageBindings;
  };

  return {
    loadSdk,
    loadRelease,
    loadPackages,
    async inspect(plan: ClaudePreparedPlan, signal: AbortSignal) {
      const [sdk, cli, packages] = await Promise.all([
        loadSdk(plan, signal),
        loadRelease(plan, signal),
        loadPackages(plan, signal),
      ]);
      return {
        sdk: { version: plan.sdk.version, exports: Object.keys(sdk).sort() },
        cli: {
          version: plan.cli.version,
          exports: Object.keys(cli).sort(),
          launch: typeof cli[plan.main.export] === "function",
        },
        packages: Object.keys(packages).sort(),
        nativeStarted: false as const,
      };
    },
  };
}
