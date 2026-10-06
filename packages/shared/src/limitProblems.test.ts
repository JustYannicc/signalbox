import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type UsageLimitSourceAccount,
} from "@t3tools/contracts";
import { ACCOUNT_HUB_SOURCE_ID } from "@t3tools/contracts/accountHub";
import { describe, expect, it } from "vite-plus/test";

import { collectLimitProblems } from "./limitProblems.ts";
import { windowRedeem, windowResetCredits } from "./usageLimitWindows.ts";
import { collectLimitAccounts } from "./usageLimits.ts";

const checkedAt = "2026-09-03T11:00:00.000Z";
const environmentId = EnvironmentId.make("env-a");
const claude = ProviderDriverKind.make("claudeAgent");
const window = (id: string, usedPercent: number) => ({
  kind: "session" as const,
  id,
  label: id,
  usedPercent,
  resetsAt: "2026-09-04T00:00:00.000Z",
});

const presentationsWith = (
  accounts: ReadonlyArray<UsageLimitSourceAccount>,
  extra: { readonly error?: string } = {},
) =>
  new Map([
    [
      environmentId,
      {
        entry: { target: { label: "Laptop" } },
        serverConfig: {
          providers: [] as ReadonlyArray<ServerProvider>,
          usageLimitSources: [
            {
              id: ACCOUNT_HUB_SOURCE_ID,
              kind: "cliproxy" as const,
              label: "Signalbox",
              checkedAt,
              accounts,
              ...extra,
            },
          ],
        },
      },
    ],
  ]);

describe("collectLimitProblems", () => {
  it("flags dead logins and an unreadable hub, not paused accounts", () => {
    const presentations = presentationsWith(
      [
        {
          id: "dead.json",
          driver: claude,
          email: "dead@example.com",
          usageLimits: { checkedAt, windows: [] },
          signedOut: true,
        },
        {
          id: "paused.json",
          driver: claude,
          email: "paused@example.com",
          usageLimits: { checkedAt, windows: [] },
          signedOut: true,
          disabled: true,
        },
        { id: "fine.json", driver: claude, usageLimits: { checkedAt, windows: [] } },
      ],
      { error: "Could not reach hub.example.com (ECONNREFUSED)." },
    );
    expect(collectLimitProblems(presentations).map(({ title, detail }) => [title, detail])).toEqual(
      [
        ["Account signed out", "dead@example.com needs a new sign-in."],
        ["The Signalbox pool is not working", "Could not reach hub.example.com (ECONNREFUSED)."],
      ],
    );
  });
});

describe("per-window reset credits", () => {
  const [account] = collectLimitAccounts(
    presentationsWith([
      {
        id: "claude.json",
        driver: claude,
        email: "claude@example.com",
        usageLimits: {
          checkedAt,
          windows: [window("five_hour", 90), window("seven_day", 40), window("seven_day_fable", 0)],
          resetCredits: {
            availableCount: 2,
            nextCreditId: "full",
            windows: [
              { windowId: "five_hour", availableCount: 2, nextCreditId: "short" },
              { windowId: "seven_day", availableCount: 1, nextCreditId: "full" },
            ],
          },
        },
      },
    ]),
  );

  it("counts only the credits that clear each window", () => {
    expect(windowResetCredits(account!, "five_hour")?.availableCount).toBe(2);
    expect(windowResetCredits(account!, "seven_day")?.availableCount).toBe(1);
    expect(windowResetCredits(account!, "seven_day_fable")).toBeUndefined();
  });

  it("redeems the window's own credit, so a 5-hour ticket keeps the full reset", () => {
    const creditOf = (windowId: string) => {
      const input = windowRedeem(account!, windowId)?.input;
      return input && "creditId" in input ? input.creditId : undefined;
    };
    expect(creditOf("five_hour")).toBe("short");
    expect(creditOf("seven_day")).toBe("full");
  });

  it("keeps account-wide credits on every window when the provider does not split them", () => {
    const [codex] = collectLimitAccounts(
      presentationsWith([
        {
          id: "codex.json",
          driver: ProviderDriverKind.make("codex"),
          usageLimits: {
            checkedAt,
            windows: [window("weekly", 10)],
            resetCredits: { availableCount: 3, nextCreditId: "credit" },
          },
        },
      ]),
    );
    expect(windowResetCredits(codex!, "weekly")?.availableCount).toBe(3);
  });

  it("never pins a native redeem to a credit it cannot claim", () => {
    const [native] = collectLimitAccounts(
      new Map([
        [
          environmentId,
          {
            entry: { target: { label: "Laptop" } },
            serverConfig: {
              providers: [
                {
                  instanceId: ProviderInstanceId.make("claude"),
                  driver: claude,
                  enabled: true,
                  installed: true,
                  status: "ready",
                  auth: { status: "authenticated", email: "claude@example.com" },
                  checkedAt,
                  models: [],
                  slashCommands: [],
                  usageLimits: {
                    checkedAt,
                    windows: [window("five_hour", 90), window("seven_day", 40)],
                    resetCredits: {
                      availableCount: 2,
                      nextCreditId: "full",
                      windows: [
                        { windowId: "five_hour", availableCount: 2, nextCreditId: "short" },
                        { windowId: "seven_day", availableCount: 1, nextCreditId: "full" },
                      ],
                    },
                  },
                } as unknown as ServerProvider,
              ],
              usageLimitSources: [],
            },
          },
        ],
      ]),
    );
    expect(windowRedeem(native!, "five_hour")).toBeNull();
    expect(windowRedeem(native!, "seven_day")?.input).toEqual({
      instanceId: ProviderInstanceId.make("claude"),
    });
  });
});

describe("merging a hub's signed-out copy with a working native login", () => {
  it("keeps the native bars and still marks the hub copy", () => {
    const presentations = presentationsWith([
      {
        id: "dead.json",
        driver: claude,
        email: "claude@example.com",
        usageLimits: {
          checkedAt: "2026-09-03T11:30:00.000Z",
          windows: [],
          unavailable: { reason: "unsupported", message: "Signed out. Sign in again." },
        },
        signedOut: true,
      },
    ]);
    const environment = presentations.get(environmentId)!;
    presentations.set(environmentId, {
      ...environment,
      serverConfig: {
        ...environment.serverConfig,
        providers: [
          {
            instanceId: ProviderInstanceId.make("claude"),
            driver: claude,
            enabled: true,
            installed: true,
            status: "ready",
            auth: { status: "authenticated", email: "claude@example.com" },
            checkedAt,
            models: [],
            slashCommands: [],
            usageLimits: { checkedAt, windows: [window("five_hour", 20)] },
          } as unknown as ServerProvider,
        ],
      },
    });
    const [account] = collectLimitAccounts(presentations);
    expect(account?.limits.windows.map((entry) => entry.id)).toEqual(["five_hour"]);
    expect(account?.hubAccount?.signedOut).toBe(true);
  });
});
