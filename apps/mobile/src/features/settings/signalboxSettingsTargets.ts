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

/** Stable while `targets` is, so scope subscriptions keyed on it don't churn. */
export function useTargetsSupporting<T extends CapableTarget>(
  targets: readonly T[],
  capability: SignalboxEnvironmentCapability,
): readonly T[] {
  return useMemo(() => targetsSupporting(targets, capability), [targets, capability]);
}
