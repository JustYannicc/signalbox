import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";

import { environmentPresentations } from "../../state/presentation";

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

/** Whether a selected environment (`null` selects all) can save model prices. */
export function useCanEditUsagePrices(
  selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null,
): boolean {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  return hasWritableSelectedUsagePriceTarget(
    [...presentations].map(([environmentId, presentation]) => ({
      environmentId,
      serverSettingsWrite:
        presentation.serverConfig?.environment?.capabilities?.serverSettingsWrite,
    })),
    selectedEnvironmentIds,
  );
}
