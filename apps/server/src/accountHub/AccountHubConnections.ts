/**
 * Switching the account hub and importing into it, as one place every
 * transport (RPC, MCP, CLI) can call.
 *
 * Claude, Grok, and Antigravity hub instances read the hub's address once,
 * when they are built, so a switch bumps their `hubRevision` and the provider
 * registry rebuilds them against the new hub.
 *
 * @module accountHub/AccountHubConnections
 */
import type {
  AccountHubImportInput,
  AccountHubSetConnectionInput,
} from "@t3tools/contracts/accountHub";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Settings from "../serverSettings.ts";
import * as AccountHub from "./AccountHub.ts";
import { AccountHubError } from "./accountHubManagement.ts";

const isHubInstance = (config: unknown) =>
  config !== null &&
  typeof config === "object" &&
  "setupMode" in config &&
  config.setupMode === "hub";

const make = Effect.gen(function* () {
  const hub = yield* AccountHub.AccountHub;
  const settings = yield* Settings.ServerSettingsService;

  const rebuildHubInstances = Effect.gen(function* () {
    const current = yield* settings.getSettings;
    const revision = yield* Clock.currentTimeMillis;
    const providerInstances = Object.fromEntries(
      Object.entries(current.providerInstances).map(([id, instance]) => [
        id,
        isHubInstance(instance.config)
          ? { ...instance, config: { ...(instance.config as object), hubRevision: revision } }
          : instance,
      ]),
    );
    yield* settings.updateSettings({ providerInstances });
  }).pipe(
    Effect.mapError(
      (cause) =>
        new AccountHubError({
          detail: "The hub changed, but its providers could not restart. Restart Signalbox.",
          cause,
        }),
    ),
  );

  return AccountHubConnections.of({
    connection: hub.connection,
    setConnection: (input) => hub.setConnection(input).pipe(Effect.tap(() => rebuildHubInstances)),
    importAccounts: (input) => hub.importAccounts(input),
  });
});

export class AccountHubConnections extends Context.Service<
  AccountHubConnections,
  {
    readonly connection: AccountHub.AccountHub["Service"]["connection"];
    readonly setConnection: (
      input: AccountHubSetConnectionInput,
    ) => ReturnType<AccountHub.AccountHub["Service"]["setConnection"]>;
    readonly importAccounts: (
      input: AccountHubImportInput,
    ) => ReturnType<AccountHub.AccountHub["Service"]["importAccounts"]>;
  }
>()("t3/accountHub/AccountHubConnections") {}

export const layer = Layer.effect(AccountHubConnections, make);
