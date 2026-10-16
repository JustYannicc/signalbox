import { DEFAULT_MODEL, ProviderInstanceId } from "@t3tools/contracts";
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
  it("names a pool's default model even when its accounts need attention", () => {
    const providers = [provider(false)];
    expect(poolDefaultModelSelection(providers)).toBeNull();
    expect(poolFallbackModelSelection(providers)).toEqual({
      instanceId: "personal-codex",
      model: DEFAULT_MODEL,
    });
  });

  it("has nothing to name without a pool", () => {
    expect(poolFallbackModelSelection([])).toBeNull();
  });
});
