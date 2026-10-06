import { AccountProvider } from "@t3tools/contracts/account";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { WorkOSConfig } from "./WorkOSClient.ts";

/**
 * Fork-owned account settings, read from the environment:
 * - `T3CODE_WORKOS_CLIENT_ID`: absent disables accounts.
 * - `T3CODE_WORKOS_API_KEY`: optional; without it WorkOS sees a PKCE public client.
 * - `T3CODE_WORKOS_API_BASE_URL`: defaults to `https://api.workos.com`.
 * - `T3CODE_WORKOS_PROVIDERS`: optional comma list, in display order.
 */

export interface AccountConfig {
  readonly workos: WorkOSConfig;
  readonly providers: ReadonlyArray<AccountProvider>;
}

const ALL_PROVIDERS = AccountProvider.literals;
const isProvider = (value: string): value is AccountProvider =>
  (ALL_PROVIDERS as ReadonlyArray<string>).includes(value);

/** Keeps known providers in the given order, once each. Empty or unset means all. */
function parseProviders(raw: string | undefined): {
  readonly providers: ReadonlyArray<AccountProvider>;
  readonly ignored: ReadonlyArray<string>;
} {
  const entries = (raw ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  const providers = [...new Set(entries.filter(isProvider))];
  const ignored = entries.filter((entry) => !isProvider(entry));
  return { providers: providers.length > 0 ? providers : ALL_PROVIDERS, ignored };
}

/** `undefined` when accounts are disabled. */
export const read = Effect.gen(function* () {
  const clientId = Option.getOrUndefined(
    yield* Config.String("T3CODE_WORKOS_CLIENT_ID").pipe(Config.option),
  )?.trim();
  if (!clientId) return undefined;
  const apiKey = yield* Config.Redacted("T3CODE_WORKOS_API_KEY").pipe(Config.option);
  const apiBaseUrl = yield* Config.String("T3CODE_WORKOS_API_BASE_URL").pipe(
    Config.withDefault("https://api.workos.com"),
  );
  const rawProviders = yield* Config.String("T3CODE_WORKOS_PROVIDERS").pipe(Config.option);
  const { providers, ignored } = parseProviders(Option.getOrUndefined(rawProviders));
  if (ignored.length > 0) {
    yield* Effect.logWarning("Ignoring unknown T3CODE_WORKOS_PROVIDERS entries", {
      ignored,
      providers,
    });
  }
  if (Option.isNone(apiKey)) {
    yield* Effect.logWarning(
      "Signalbox accounts are enabled without T3CODE_WORKOS_API_KEY; sign-ins that need email verification (e.g. GitHub) will fail",
    );
  }
  return {
    workos: {
      clientId,
      ...(Option.isSome(apiKey) ? { apiKey: apiKey.value } : {}),
      apiBaseUrl,
    },
    providers,
  } satisfies AccountConfig;
});
