import { describe, expect, it } from "@effect/vitest";
import {
  AuthAccessReadScope,
  AuthOrchestrationReadScope,
  AuthRelayReadScope,
  AuthStandardClientScopes,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ServerProvider,
  type UsageLimitSourceSnapshot,
  WS_METHODS,
} from "@t3tools/contracts";
import { type AccountPool, AccountPoolId, poolSourceId } from "@t3tools/contracts/accountHub";

import { RPC_REQUIRED_SCOPES } from "../auth/RpcAuthorization.ts";
import { buildPoolOverviews } from "./poolOverview.ts";
import { poolRole, visibleProviders, visibleUsageLimitSources, withRole } from "./poolAccess.ts";

const EMAIL = "secret-account@example.com";
const READ_ONLY = [AuthOrchestrationReadScope, AuthAccessReadScope, AuthRelayReadScope];

const pool: AccountPool = {
  id: AccountPoolId.make("team"),
  name: "Team",
  sourceId: poolSourceId("team"),
  backing: { mode: "managed" },
  personal: false,
};

const instances = {
  claude_hub_team: { driver: "claude", config: { setupMode: "hub", poolId: "team" } },
  claude: { driver: "claude" },
} as unknown as Record<string, ProviderInstanceConfig>;

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

const provider = (instanceId: string): ServerProvider =>
  ({
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("claude"),
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
        driver: ProviderDriverKind.make("claude"),
        email: EMAIL,
        plan: "Max",
        usageLimits,
      },
    ],
  } as unknown as UsageLimitSourceSnapshot,
];

const providers = [provider("claude_hub_team"), provider("claude")];

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
    instances,
    providers,
    sources,
    now: Date.parse("2026-10-07T10:00:00.000Z"),
  });

  it("carry no account count, email, plan, or reset credit", () => {
    const wire = JSON.stringify({
      // The operator's own non-pool sign-in is not a pool's to hide.
      providers: visibleProviders("member", [providers[0]!], instances),
      usageLimitSources: visibleUsageLimitSources("member", sources),
      pools: withRole("member", overviews),
    });
    expect(wire).not.toContain(EMAIL);
    expect(wire).not.toContain("3 accounts");
    expect(wire).not.toContain("Max");
    expect(wire).not.toContain("max");
    expect(wire).not.toContain("resetCredits");
  });

  it("still say what is left in each pool and when it resets", () => {
    expect(withRole("member", overviews)).toEqual([
      {
        id: "team",
        name: "Team",
        role: "member",
        providers: [
          {
            providerInstanceId: "claude_hub_team",
            driver: "claude",
            displayName: "Claude",
            available: true,
            usage: [
              {
                label: "5 hours",
                kind: "session",
                remainingPercent: 60,
                nextResetAt: "2026-10-07T12:00:00.000Z",
              },
            ],
          },
        ],
      },
    ]);
  });

  it("leave providers that run on no pool alone", () => {
    expect(visibleProviders("member", providers, instances)[1]).toBe(providers[1]);
  });
});

describe("admin payloads", () => {
  it("are what an admin sees today", () => {
    expect(visibleProviders("admin", providers, instances)).toBe(providers);
    expect(visibleUsageLimitSources("admin", sources)).toBe(sources);
  });
});
