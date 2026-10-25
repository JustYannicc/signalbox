/**
 * signalbox: settings targets limited to environments that serve a settings
 * area (see `signalboxCapabilities.ts`). Signalbox Cloud writes no server
 * settings, so those screens leave it out instead of failing on it.
 */
import {
  type ExecutionEnvironmentCapabilities,
  type SignalboxEnvironmentCapability,
  environmentSupports,
} from "@t3tools/contracts";
import { useMemo } from "react";

interface CapableTarget {
  readonly serverConfig: {
    readonly environment: { readonly capabilities: ExecutionEnvironmentCapabilities };
  };
}

interface RepositoryIdentityTarget {
  readonly serverConfig: {
    readonly environment: {
      readonly capabilities: { readonly repositoryIdentity: boolean };
    };
  };
}

export function targetsSupporting<T extends CapableTarget>(
  targets: readonly T[],
  capability: SignalboxEnvironmentCapability,
): readonly T[] {
  return targets.filter((target) =>
    environmentSupports(target.serverConfig.environment.capabilities, capability),
  );
}

export function targetsWithRepositoryIdentity<T extends RepositoryIdentityTarget>(
  targets: readonly T[],
): readonly T[] {
  return targets.filter(
    (target) => target.serverConfig.environment.capabilities.repositoryIdentity,
  );
}

/** Provider accounts only signs in installed ACP agents; pools hold every other account. */
export function signsInHere(provider: {
  readonly driver: string;
  readonly installed: boolean;
}): boolean {
  return provider.driver === "acpRegistry" && provider.installed;
}

/** Targets where Provider accounts has something to sign in. The cloud runs no ACP agents. */
export function targetsWithProviderAccounts<T extends { readonly environmentId: string }>(
  targets: readonly T[],
  providersByEnvironment: ReadonlyMap<
    string,
    ReadonlyArray<{ readonly driver: string; readonly installed: boolean }>
  >,
): readonly T[] {
  return targets.filter((target) =>
    (providersByEnvironment.get(target.environmentId) ?? []).some(signsInHere),
  );
}

/** Stable while `targets` is, so scope subscriptions keyed on it don't churn. */
export function useTargetsSupporting<T extends CapableTarget>(
  targets: readonly T[],
  capability: SignalboxEnvironmentCapability,
): readonly T[] {
  return useMemo(() => targetsSupporting(targets, capability), [targets, capability]);
}
