/**
 * signalbox: pool instances. An instance set up as `hub` runs its driver on
 * a pool's accounts through the account hub; anything else goes straight to
 * the upstream driver. The branch wraps each driver where the server
 * registers it (`builtInDrivers.ts`) instead of living in the driver's
 * `create`, so drivers that ship in provider packages, which cannot reach the
 * account hub, get it too, and upstream's driver files carry no fork code.
 *
 * @module accountHub/hubDrivers
 */
import type {
  ProviderDriver,
  ProviderDriverCreateInput,
  ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import type { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { CursorDriver } from "@t3tools/provider-cursor/server";
import { GrokDriver } from "@t3tools/provider-grok/server";
import { OpenCodeDriver } from "@t3tools/provider-opencode/server";
import type * as Effect from "effect/Effect";

import { AntigravityDriver } from "../provider/Drivers/AntigravityDriver.ts";
import { ClaudeDriver } from "../provider/Drivers/ClaudeDriver.ts";
import { CodexDriver } from "../provider/Drivers/CodexDriver.ts";
import type * as AccountHub from "./AccountHub.ts";
import { makeHubCodexProvider } from "./HubCodexProvider.ts";
import {
  makeHubAntigravityInstance,
  makeHubClaudeInstance,
  makeHubCursorInstance,
  makeHubGrokInstance,
  makeHubOpenCodeInstance,
} from "./HubDriverInstance.ts";
import { withAccountHub } from "./hubInstance.ts";

const withPoolSetup = <
  Config extends { readonly setupMode?: string | undefined; readonly poolId?: string | undefined },
  R,
  UsageR,
  HubR,
>(
  driver: ProviderDriver<Config, R, UsageR>,
  makeHub: (
    input: ProviderDriverCreateInput<Config>,
    create: ProviderDriver<Config, R, UsageR>["create"],
  ) => Effect.Effect<ProviderInstance, ProviderDriverError, HubR>,
): ProviderDriver<Config, R | Exclude<HubR, AccountHub.AccountHub>, UsageR> => ({
  ...driver,
  create: (input) =>
    input.config.setupMode === "hub"
      ? withAccountHub(
          driver.driverKind,
          input.instanceId,
          input.config.poolId,
          makeHub(input, driver.create),
        )
      : driver.create(input),
});

export const HubCodexDriver = withPoolSetup(CodexDriver, (input) => makeHubCodexProvider(input));
export const HubClaudeDriver = withPoolSetup(ClaudeDriver, (input, create) =>
  makeHubClaudeInstance(ClaudeDriver.driverKind, input, create),
);
export const HubCursorDriver = withPoolSetup(CursorDriver, makeHubCursorInstance);
export const HubGrokDriver = withPoolSetup(GrokDriver, (input, create) =>
  makeHubGrokInstance(GrokDriver.driverKind, input, create),
);
export const HubOpenCodeDriver = withPoolSetup(OpenCodeDriver, makeHubOpenCodeInstance);
export const HubAntigravityDriver = withPoolSetup(AntigravityDriver, (input, create) =>
  makeHubAntigravityInstance(AntigravityDriver.driverKind, input, create),
);

const HUB_DRIVERS = [
  HubCodexDriver,
  HubClaudeDriver,
  HubCursorDriver,
  HubGrokDriver,
  HubOpenCodeDriver,
  HubAntigravityDriver,
] as const;

/** What the pool branches need beyond the drivers themselves. */
export type HubDriversEnv =
  (typeof HUB_DRIVERS)[number] extends ProviderDriver<any, infer R, any> ? R : never;
