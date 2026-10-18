import { isProviderAvailable, type ServerProvider } from "@t3tools/contracts";

/** Refresh warnings remain visible even when the cached catalog can still run a child. */
export const providerChildTasks = (provider: ServerProvider, hasAdapter = true) => {
  const blockers: string[] = [];
  if (!hasAdapter) blockers.push("No V2 provider adapter is registered.");
  if (!provider.enabled) blockers.push("Provider instance is disabled.");
  if (!provider.installed) blockers.push("Provider executable is not installed.");
  if (!isProviderAvailable(provider))
    blockers.push(provider.unavailableReason ?? "Provider driver is unavailable.");
  if (provider.status === "error" || provider.status === "disabled")
    blockers.push(provider.message ?? `Provider status is ${provider.status}.`);
  if (provider.auth.status === "unauthenticated") blockers.push("Provider is not authenticated.");
  if (provider.models.length === 0) blockers.push("Provider has no available models.");
  return {
    canRun: blockers.length === 0,
    constraints: [
      ...new Set([
        ...blockers,
        ...(provider.message ? [provider.message] : []),
        ...(provider.unavailableReason ? [provider.unavailableReason] : []),
      ]),
    ],
  };
};
