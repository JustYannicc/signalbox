import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { poolServerProvider } from "../thread/providerCatalog.ts";
import { poolDefaultModelSelection, poolFallbackModelSelection } from "./poolViews.ts";

const provider = (signedIn: boolean) =>
  poolServerProvider({
    kind: "codex",
    instanceId: ProviderInstanceId.make("personal-codex"),
    displayName: "Personal",
    signedIn,
    models: [],
    checkedAt: "2026-10-16T00:00:00.000Z",
  });

describe("poolFallbackModelSelection", () => {
  it("never invents a model when the pool has no served models", () => {
    const providers = [provider(false)];
    expect(poolDefaultModelSelection(providers)).toBeNull();
    expect(poolFallbackModelSelection(providers)).toBeNull();
  });

  it("uses a listed model when the provider is temporarily unavailable", () => {
    expect(
      poolFallbackModelSelection([
        {
          ...provider(true),
          models: [{ slug: "new-model", name: "New model", isCustom: false, capabilities: null }],
        },
      ]),
    ).toEqual({ instanceId: "personal-codex", model: "new-model" });
  });

  it("has nothing to name without a pool", () => {
    expect(poolFallbackModelSelection([])).toBeNull();
  });
});
