import type { ProviderInstanceConfig, ServerProvider } from "@t3tools/contracts";
import { MOVABLE_NATIVE_DRIVERS, hubInstancePoolId } from "@t3tools/contracts/accountHub";

/**
 * Providers signed in on the server machine itself (native logins) that can
 * move into a pool: enabled, signed in, and not already a pool's provider.
 */
export function movableNativeLogins(
  providers: ReadonlyArray<ServerProvider> | null | undefined,
  instances: Readonly<Record<string, ProviderInstanceConfig>>,
): ReadonlyArray<ServerProvider> {
  return (providers ?? []).filter(
    (provider) =>
      provider.enabled &&
      provider.auth.status === "authenticated" &&
      MOVABLE_NATIVE_DRIVERS.includes(provider.driver) &&
      hubInstancePoolId(instances[provider.instanceId]?.config) === null,
  );
}

/** "Claude (me@example.com)", or just the provider's name when it has no email. */
export function nativeLoginLabel(provider: ServerProvider) {
  const name = provider.displayName ?? provider.driver;
  return provider.auth.email ? `${name} (${provider.auth.email})` : name;
}

/**
 * Upstream's native sign-in UI (a CLI's own login, Sign in with ChatGPT on a
 * provider) stays in place behind this switch so upstream merges apply
 * cleanly. Signalbox keeps every account in a pool, so it is always off.
 */
export const NATIVE_SIGN_IN = false as boolean;
