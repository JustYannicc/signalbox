import { describe, expect, it } from "@effect/vitest";
import {
  AuthAccessReadScope,
  AuthOrchestrationReadScope,
  AuthRelayReadScope,
  AuthStandardClientScopes,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type UsageLimitSourceSnapshot,
  WS_METHODS,
} from "@t3tools/contracts";
import { type AccountPool, AccountPoolId, poolSourceId } from "@t3tools/contracts/accountHub";
import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@t3tools/contracts/settings";

import { RPC_REQUIRED_SCOPES } from "../auth/RpcAuthorization.ts";
import { buildPoolOverviews } from "./poolOverview.ts";
import { poolRole, visibleProviders, visibleUsageLimitSources } from "./poolAccess.ts";

const EMAIL = "secret-account@example.com";
const READ_ONLY = [AuthOrchestrationReadScope, AuthAccessReadScope, AuthRelayReadScope];

const pool: AccountPool = {
  id: AccountPoolId.make("team"),
  name: "Team",
  sourceId: poolSourceId("team"),
  backing: { mode: "managed" },
  personal: false,
};

const settings = {
  ...DEFAULT_SERVER_SETTINGS,
  providerInstances: {
    claude_hub_team: { driver: "claudeAgent", config: { setupMode: "hub", poolId: "team" } },
  },
  // A legacy entry runs on the personal pool with no `providerInstances` entry.
  providers: { ...DEFAULT_SERVER_SETTINGS.providers, codex: { setupMode: "hub" } },
} as unknown as ServerSettings;

const usageLimits = {
  checkedAt: "2026-10-07T10:00:00.000Z",
  windows: [
    {
      id: "five_hour",
      kind: "session" as const,
      label: "5 hours",
      usedPercent: 40,
      resetsAt: "2026-10-07T12:00:00.000Z",
    },
  ],
  resetCredits: { availableCount: 2 },
};

const provider = (instanceId: string, driver: string): ServerProvider =>
  ({
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    displayName: "Claude",
    enabled: true,
    auth: { status: "authenticated", label: "3 accounts", email: EMAIL, profileId: "max" },
    usageLimits,
  }) as unknown as ServerProvider;

const sources: ReadonlyArray<UsageLimitSourceSnapshot> = [
  {
    id: poolSourceId("team"),
    kind: "cliproxy",
    label: "Team",
    checkedAt: "2026-10-07T10:00:00.000Z",
    accounts: [
      {
        id: "a",
        driver: ProviderDriverKind.make("claudeAgent"),
        email: EMAIL,
        plan: "Max",
        usageLimits,
      },
    ],
  } as unknown as UsageLimitSourceSnapshot,
];

const poolProviders = [provider("claude_hub_team", "claudeAgent"), provider("codex", "codex")];
const ownProvider = provider("claudeAgent", "claudeAgent");

describe("poolRole", () => {
  it("makes a session that may operate the environment an admin, and a read-only one a member", () => {
    expect(poolRole(AuthStandardClientScopes)).toBe("admin");
    expect(poolRole(READ_ONLY)).toBe("member");
  });

  it("only lets admins redeem resets or manage pools and accounts", () => {
    const adminOnly = [
      WS_METHODS.providerConsumeResetCredit,
      WS_METHODS.usageLimitSourceUpdateAccount,
      WS_METHODS.accountPoolSubscribe,
      WS_METHODS.accountPoolCreate,
      WS_METHODS.accountPoolRename,
      WS_METHODS.accountPoolDelete,
      WS_METHODS.accountPoolSetBacking,
      WS_METHODS.accountPoolImportAccounts,
      WS_METHODS.accountPoolAddApiKey,
      WS_METHODS.accountPoolMoveNativeLogins,
      WS_METHODS.accountPoolSetOpenCode,
      WS_METHODS.providerAuthStart,
      WS_METHODS.providerAuthSubscribe,
      WS_METHODS.serverRefreshProviders,
      WS_METHODS.serverUpdateProvider,
    ] as const;
    for (const method of adminOnly) {
      const required = RPC_REQUIRED_SCOPES[method];
      expect(READ_ONLY, method).not.toContain(required);
      expect(poolRole([required]), method).toBe("admin");
    }
    expect(RPC_REQUIRED_SCOPES[WS_METHODS.accountPoolSubscribeViews]).toBe(
      AuthOrchestrationReadScope,
    );
  });
});

describe("member payloads", () => {
  const overviews = buildPoolOverviews({
    pools: [pool],
    instances: settings.providerInstances,
    providers: poolProviders,
    sources,
    now: Date.parse("2026-10-07T10:00:00.000Z"),
  });

  it("carry no account count, email, plan, or reset credit", () => {
    const wire = JSON.stringify({
      providers: visibleProviders("member", poolProviders, settings),
      usageLimitSources: visibleUsageLimitSources("member", sources),
      pools: overviews,
    });
    expect(wire).not.toContain(EMAIL);
    expect(wire).not.toContain("3 accounts");
    expect(wire).not.toContain("Max");
    expect(wire).not.toContain("max");
    expect(wire).not.toContain("resetCredits");
  });

  it("still say what is left in each pool and when it resets", () => {
    expect(overviews[0]?.providers[0]?.usage).toEqual([
      {
        label: "5 hours",
        kind: "session",
        remainingPercent: 60,
        nextResetAt: "2026-10-07T12:00:00.000Z",
      },
    ]);
  });

  it("leave providers that run on no pool alone", () => {
    expect(visibleProviders("member", [ownProvider], settings)[0]).toBe(ownProvider);
  });
});

describe("admin payloads", () => {
  it("are what an admin sees today", () => {
    const providers = [...poolProviders, ownProvider];
    expect(visibleProviders("admin", providers, settings)).toBe(providers);
    expect(visibleUsageLimitSources("admin", sources)).toBe(sources);
  });
});
