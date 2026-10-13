import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type UsageLimitSourceAccount,
  type UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import { type AccountPool, AccountPoolId, poolSourceId } from "@t3tools/contracts/accountHub";

import { buildPoolOverviews, pooledUsage } from "./poolOverview.ts";

const pool = (id: string, name: string): AccountPool => ({
  id: AccountPoolId.make(id),
  name,
  sourceId: poolSourceId(id),
  backing: { mode: "managed" },
  personal: id === "personal",
});

const provider = (instanceId: string, driver: string, enabled = true) =>
  ({
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    displayName: instanceId,
    enabled,
  }) as ServerProvider;

const account = (
  id: string,
  driver: string,
  windows: ReadonlyArray<{ id: string; used: number; resetsAt?: string }>,
  extra: Partial<UsageLimitSourceAccount> = {},
): UsageLimitSourceAccount => ({
  id,
  driver: ProviderDriverKind.make(driver),
  email: `${id}@example.com`,
  plan: "Max",
  usageLimits: {
    checkedAt: "2026-10-07T10:00:00.000Z",
    windows: windows.map((window) => ({
      id: window.id,
      kind: window.id === "five_hour" ? ("session" as const) : ("weekly" as const),
      label: window.id === "five_hour" ? "5 hours" : "Week",
      usedPercent: window.used,
      ...(window.resetsAt ? { resetsAt: window.resetsAt } : {}),
    })),
    resetCredits: { availableCount: 2 },
  },
  ...extra,
});

const source = (
  poolId: string,
  accounts: ReadonlyArray<UsageLimitSourceAccount>,
): UsageLimitSourceSnapshot => ({
  id: poolSourceId(poolId),
  kind: "cliproxy",
  label: poolId,
  checkedAt: "2026-10-07T10:00:00.000Z",
  accounts,
});

describe("buildPoolOverviews", () => {
  const overviews = buildPoolOverviews({
    pools: [pool("personal", "Personal"), pool("work", "Work")],
    instances: {
      claude_hub: { driver: ProviderDriverKind.make("claudeAgent"), config: { setupMode: "hub" } },
      codex_hub: { driver: ProviderDriverKind.make("codex"), config: { setupMode: "hub" } },
      claude_hub_work: {
        driver: ProviderDriverKind.make("claudeAgent"),
        config: { setupMode: "hub", poolId: "work" },
      },
      grok_hub_work: {
        driver: ProviderDriverKind.make("grok"),
        config: { setupMode: "hub", poolId: "work" },
      },
      claudeAgent: { driver: ProviderDriverKind.make("claudeAgent") },
    },
    providers: [
      provider("claude_hub", "claudeAgent"),
      provider("codex_hub", "codex"),
      provider("claude_hub_work", "claudeAgent"),
      provider("grok_hub_work", "grok", false),
      provider("claudeAgent", "claudeAgent"),
    ],
    sources: [
      source("personal", [
        account("a", "claudeAgent", [
          { id: "five_hour", used: 80, resetsAt: "2026-10-07T12:00:00.000Z" },
          { id: "seven_day", used: 40, resetsAt: "2026-10-10T00:00:00.000Z" },
        ]),
        account("b", "claudeAgent", [
          { id: "five_hour", used: 20, resetsAt: "2026-10-07T11:00:00.000Z" },
          { id: "seven_day", used: 0, resetsAt: "2026-10-09T00:00:00.000Z" },
        ]),
        // Paused and signed-out accounts take no turns, so they neither count nor drag the share.
        account("c", "claudeAgent", [{ id: "five_hour", used: 100 }], { disabled: true }),
        account("d", "codex", [{ id: "five_hour", used: 100 }], { signedOut: true }),
      ]),
      source("work", [account("e", "claudeAgent", [{ id: "five_hour", used: 10 }])]),
    ],
    now: Date.parse("2026-10-07T10:30:00.000Z"),
  });

  it("lists each pool with only the enabled providers it runs", () => {
    expect(overviews.map((overview) => overview.name)).toEqual(["Personal", "Work"]);
    expect(overviews[0]!.providers.map((entry) => entry.providerInstanceId)).toEqual([
      "claude_hub",
      "codex_hub",
    ]);
    expect(overviews[1]!.providers.map((entry) => entry.providerInstanceId)).toEqual([
      "claude_hub_work",
    ]);
  });

  it("pools what is left per window with the next reset that gives quota back", () => {
    const claude = overviews[0]!.providers[0]!;
    expect(claude.available).toBe(true);
    expect(claude.usage).toEqual([
      {
        label: "5 hours",
        kind: "session",
        remainingPercent: 50,
        nextResetAt: "2026-10-07T11:00:00.000Z",
      },
      // The untouched account's earlier reset hands nothing back.
      {
        label: "Week",
        kind: "weekly",
        remainingPercent: 80,
        nextResetAt: "2026-10-10T00:00:00.000Z",
      },
    ]);
    expect(overviews[1]!.providers[0]!.usage).toEqual([
      { label: "5 hours", kind: "session", remainingPercent: 90 },
    ]);
  });

  it("marks a provider with no working account unavailable", () => {
    const codex = overviews[0]!.providers[1]!;
    expect(codex).toMatchObject({ available: false, usage: [] });
  });

  it("counts a window whose reset has passed since the last read as open again", () => {
    const stale = [
      account("f", "claudeAgent", [
        { id: "five_hour", used: 100, resetsAt: "2026-10-07T10:00:00.000Z" },
      ]),
    ];
    expect(pooledUsage(stale, Date.parse("2026-10-07T10:30:00.000Z"))).toEqual([
      { label: "5 hours", kind: "session", remainingPercent: 100 },
    ]);
  });

  it("marks a provider whose every account is used up unavailable", () => {
    const [overview] = buildPoolOverviews({
      pools: [pool("work", "Work")],
      instances: {
        claude_hub_work: {
          driver: ProviderDriverKind.make("claudeAgent"),
          config: { setupMode: "hub", poolId: "work" },
        },
      },
      providers: [provider("claude_hub_work", "claudeAgent")],
      sources: [
        source("work", [
          account("g", "claudeAgent", [
            { id: "five_hour", used: 100, resetsAt: "2026-10-07T12:00:00.000Z" },
          ]),
        ]),
      ],
      now: Date.parse("2026-10-07T10:30:00.000Z"),
    });
    expect(overview!.providers[0]).toMatchObject({
      available: false,
      usage: [{ remainingPercent: 0, nextResetAt: "2026-10-07T12:00:00.000Z" }],
    });
  });

  it("never carries account counts, emails, plans, or banked resets", () => {
    const text = JSON.stringify(overviews);
    for (const leak of ["@example.com", "Max", "availableCount", "resetCredits", '"accounts"']) {
      expect(text).not.toContain(leak);
    }
  });
});
