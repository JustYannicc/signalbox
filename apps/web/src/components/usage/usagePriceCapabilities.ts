import type { EnvironmentId } from "@t3tools/contracts";

export interface UsagePriceCapabilityTarget {
  readonly environmentId: EnvironmentId;
  /** Absent capabilities keep the self-hosted server default. */
  readonly serverSettingsWrite: boolean | undefined;
}

export function hasWritableSelectedUsagePriceTarget(
  targets: readonly UsagePriceCapabilityTarget[],
  selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null,
): boolean {
  return targets.some(
    (target) =>
      (selectedEnvironmentIds === null || selectedEnvironmentIds.has(target.environmentId)) &&
      target.serverSettingsWrite !== false,
  );
}
