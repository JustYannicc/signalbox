import type { AccountPoolOverview } from "@t3tools/contracts/accountHub";
import type { ProviderInstanceId } from "@t3tools/contracts";

type PoolProvider = AccountPoolOverview["providers"][number];

function nextReset(provider: PoolProvider | undefined, now: number): number | undefined {
  return provider?.usage
    .flatMap((window) => (window.nextResetAt ? [Date.parse(window.nextResetAt)] : []))
    .filter((timestamp) => Number.isFinite(timestamp) && timestamp > now)
    .sort((left, right) => left - right)[0];
}

function formatReset(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(timestamp);
}

export function formatPoolModelStatus(input: {
  readonly overview: AccountPoolOverview | undefined;
  readonly providerInstanceId: ProviderInstanceId;
  readonly snapshotUnavailable: boolean;
  readonly now: number;
}): string | undefined {
  const provider = input.overview?.providers.find(
    (candidate) => candidate.providerInstanceId === input.providerInstanceId,
  );
  const reset = nextReset(provider, input.now);
  if (input.snapshotUnavailable || input.overview?.error !== undefined) {
    return reset === undefined
      ? "Status unavailable"
      : `Status unavailable · last known reset ${formatReset(reset)}`;
  }
  if (!provider) return undefined;
  if (!provider.available && provider.usage.length === 0) return "Status unavailable";
  if (provider.available) return undefined;
  return `Limited${reset === undefined ? "" : ` · resets ${formatReset(reset)}`}`;
}
