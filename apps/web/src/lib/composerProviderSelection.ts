import { ProviderDriverKind, type ProviderInstanceId } from "@t3tools/contracts";

import {
  NO_PROVIDER_MODEL_SELECTION,
  resolveSelectableProviderInstanceEntry,
  type ProviderInstanceEntry,
} from "../providerInstances";

export function resolveComposerProviderSelection(input: {
  entries: ReadonlyArray<ProviderInstanceEntry>;
  candidateInstanceIds: ReadonlyArray<ProviderInstanceId | null | undefined>;
  lockedProvider: ProviderDriverKind | null;
  lockedInstanceId: ProviderInstanceId | null | undefined;
}) {
  const requestedInstanceId = input.candidateInstanceIds.find(
    (candidate) => candidate != null && candidate !== NO_PROVIDER_MODEL_SELECTION.instanceId,
  );
  const requestedDriverKind =
    input.lockedProvider ??
    input.entries.find((entry) => entry.instanceId === requestedInstanceId)?.driverKind ??
    input.entries[0]?.driverKind ??
    ProviderDriverKind.make("unconfigured");
  const lockedContinuationGroupKey = input.lockedProvider
    ? (input.entries.find((entry) => entry.instanceId === input.lockedInstanceId)
        ?.continuationGroupKey ?? null)
    : null;
  // Missing metadata must not move Antigravity history into another Google profile.
  const requiresExactInstance =
    input.lockedProvider === "antigravity" &&
    input.lockedInstanceId != null &&
    lockedContinuationGroupKey === null;
  const compatibleEntries = input.entries.filter(
    (entry) =>
      (!input.lockedProvider || entry.driverKind === input.lockedProvider) &&
      (!lockedContinuationGroupKey || entry.continuationGroupKey === lockedContinuationGroupKey) &&
      (!requiresExactInstance || entry.instanceId === input.lockedInstanceId),
  );
  const selectedProviderEntry =
    input.candidateInstanceIds
      .map((candidate) =>
        compatibleEntries.find(
          (entry) => entry.instanceId === candidate && entry.enabled && entry.isAvailable,
        ),
      )
      .find((entry) => entry !== undefined) ??
    resolveSelectableProviderInstanceEntry(
      compatibleEntries.filter((entry) => entry.driverKind === requestedDriverKind),
      undefined,
    ) ??
    resolveSelectableProviderInstanceEntry(compatibleEntries, undefined);
  const unavailableProviderInstanceId = selectedProviderEntry
    ? undefined
    : input.lockedProvider
      ? (input.lockedInstanceId ?? requestedInstanceId)
      : requestedInstanceId;
  return {
    selectedProviderEntry,
    requestedDriverKind,
    lockedContinuationGroupKey,
    unavailableProviderInstanceId,
  };
}
