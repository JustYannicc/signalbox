import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { AccountPoolId, type AccountPoolOverview } from "@t3tools/contracts/accountHub";
import { describe, expect, it } from "vite-plus/test";

import { formatPoolModelStatus } from "@t3tools/client-runtime/poolModelStatus";

const providerInstanceId = ProviderInstanceId.make("codex_hub_work");
const now = Date.parse("2030-01-01T00:00:00.000Z");
const overview: AccountPoolOverview = {
  id: AccountPoolId.make("work"),
  name: "Work",
  providers: [
    {
      providerInstanceId,
      driver: ProviderDriverKind.make("codex"),
      displayName: "ChatGPT",
      available: false,
      usage: [
        {
          label: "Weekly",
          kind: "weekly",
          remainingPercent: 0,
          nextResetAt: "2030-01-02T03:04:00.000Z",
        },
      ],
    },
  ],
};

describe("formatPoolModelStatus", () => {
  it("shows member-safe quota state and the next future reset", () => {
    expect(
      formatPoolModelStatus({
        overview,
        providerInstanceId,
        snapshotUnavailable: false,
        now,
      }),
    ).toContain("Limited · resets ");
  });

  it("keeps the last known reset but never calls stale quota limited", () => {
    const status = formatPoolModelStatus({
      overview: { ...overview, error: "Timed out" },
      providerInstanceId,
      snapshotUnavailable: true,
      now,
    });

    expect(status).toContain("Status unavailable · last known reset ");
    expect(status).not.toContain("Limited");
  });

  it("omits expired reset times and does not invent a missing provider", () => {
    expect(
      formatPoolModelStatus({
        overview,
        providerInstanceId: ProviderInstanceId.make("claude_hub_work"),
        snapshotUnavailable: false,
        now,
      }),
    ).toBeUndefined();
    expect(
      formatPoolModelStatus({
        overview,
        providerInstanceId,
        snapshotUnavailable: false,
        now: Date.parse("2030-01-03T00:00:00.000Z"),
      }),
    ).toBe("Limited");
  });
});
