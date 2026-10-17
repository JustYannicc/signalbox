// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProviderModel,
} from "@t3tools/contracts";

import {
  groupModelsForDisplay,
  nextHiddenModelsForBulkToggle,
  ProviderModelsSection,
} from "./ProviderModelsSection";

function model(slug: string, isCustom = false): ServerProviderModel {
  return { slug, name: slug, isCustom, capabilities: null };
}

describe("groupModelsForDisplay", () => {
  it("lists favorites first, then visible models in user order, then hidden ones", () => {
    const models = [model("a"), model("b"), model("c"), model("d"), model("custom", true)];

    const display = groupModelsForDisplay(models, {
      favoriteModels: new Set(["c"]),
      hiddenModels: new Set(["a", "custom"]),
      modelOrder: ["d", "b"],
    });

    expect(display.map((entry) => entry.slug)).toEqual(["c", "d", "b", "custom", "a"]);
  });
});

describe("nextHiddenModelsForBulkToggle", () => {
  it("hides every built-in model without hiding custom models", () => {
    const models = [model("a"), model("b"), model("custom", true)];

    expect(nextHiddenModelsForBulkToggle(models, ["a"])).toEqual(["a", "b"]);
  });

  it("shows every built-in model while preserving unrelated hidden entries", () => {
    const models = [model("a"), model("b"), model("custom", true)];

    expect(nextHiddenModelsForBulkToggle(models, ["a", "b", "legacy", "custom"])).toEqual([
      "legacy",
      "custom",
    ]);
  });
});

describe("ProviderModelsSection write capability", () => {
  it("keeps model rows visible while removing controls that cannot save", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const renderer = createRoot(container);
    const onHiddenModelsChange = vi.fn();
    await act(async () => {
      renderer.render(
        createElement(ProviderModelsSection, {
          instanceId: ProviderInstanceId.make("codex_hub"),
          driverKind: ProviderDriverKind.make("codex"),
          models: [model("pool-model")],
          customModels: [],
          canManageCustomModels: false,
          canWritePreferences: false,
          hiddenModels: [],
          favoriteModels: [],
          modelOrder: [],
          onChange: vi.fn(),
          onHiddenModelsChange,
          onFavoriteModelsChange: vi.fn(),
          onToggleFavorite: vi.fn(),
          onModelOrderChange: vi.fn(),
        }),
      );
    });

    try {
      expect(container.querySelector('[data-model-slug="pool-model"]')).not.toBeNull();
      const buttons = [...container.querySelectorAll("button")];
      expect(buttons.some((button) => button.textContent?.includes("Add custom model"))).toBe(
        false,
      );
      const bulkToggle = buttons.find((button) => button.textContent === "Disable all");
      expect(bulkToggle?.disabled).toBe(true);
      await act(async () => bulkToggle?.click());
      expect(onHiddenModelsChange).not.toHaveBeenCalled();
    } finally {
      await act(async () => renderer.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  });
});
