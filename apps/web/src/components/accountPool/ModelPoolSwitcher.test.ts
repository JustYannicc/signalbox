import {
  ProviderDriverKind,
  ProviderInstanceId,
  UsageLimitSourceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { type AccountPool, AccountPoolId } from "@t3tools/contracts/accountHub";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderInstanceEntries } from "../../providerInstances";
import { initialPickerPool, pickerPools } from "./ModelPoolSwitcher";

const provider = (instanceId: string, driver: string): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-07T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
});

const pool = (id: string, name: string): AccountPool => ({
  id: AccountPoolId.make(id),
  name,
  sourceId: UsageLimitSourceId.make(`pool-${id}`),
  backing:
    id === "work" ? { mode: "external", url: "https://hub.example.com" } : { mode: "managed" },
  personal: id === "personal",
});

const entries = deriveProviderInstanceEntries([
  provider("claude_hub", "claudeAgent"),
  provider("codex_hub", "codex"),
  provider("claude_hub_work", "claudeAgent"),
  provider("cursor", "cursor"),
]);

const providerInstances = {
  claude_hub: { driver: ProviderDriverKind.make("claudeAgent"), config: { setupMode: "hub" } },
  codex_hub: { driver: ProviderDriverKind.make("codex"), config: { setupMode: "hub" } },
  claude_hub_work: {
    driver: ProviderDriverKind.make("claudeAgent"),
    config: { setupMode: "hub", poolId: "work" },
  },
};

describe("pickerPools", () => {
  const pools = pickerPools(
    [pool("personal", "Personal"), pool("work", "Work"), pool("empty", "Empty")],
    entries,
    providerInstances,
  );

  it("offers each pool's own providers, then the ones no pool holds", () => {
    expect(pools.map((entry) => [entry.name, [...entry.instanceIds]])).toEqual([
      ["Personal", ["claude_hub", "codex_hub"]],
      ["Work", ["claude_hub_work"]],
      ["Not in a pool", ["cursor"]],
    ]);
  });

  it("opens on the pool running the current model", () => {
    expect(initialPickerPool(pools, ProviderInstanceId.make("claude_hub_work"))).toBe("work");
    expect(initialPickerPool(pools, ProviderInstanceId.make("codex_hub"))).toBe("personal");
  });

  it("shows no pool switcher while there is nothing to choose between", () => {
    expect(
      pickerPools([pool("personal", "Personal")], entries.slice(0, 2), providerInstances),
    ).toEqual([]);
  });
});
