import type { ClaudePreparedPlan, ClaudePreparedModuleImporter } from "./claudePreparedNames.ts";
import type { ClaudeIsolateAdapterOptions } from "../../../../src/harness/ClaudeIsolateAdapter.ts";
import type { PreparedClaudeSdk } from "../../../../src/harness/ClaudeIsolateAdapter.ts";
import {
  claudePreparedModuleSpecifier,
  claudeEnvironmentPackageModuleSpecifier,
} from "./claudePreparedNames.ts";
const environmentPackages = new Set(["undici", "yaml", "ws", "node-fetch", "bun:jsc"]);
type PackageBindings = Awaited<ReturnType<ClaudeIsolateAdapterOptions["process"]["loadPackages"]>>;
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
