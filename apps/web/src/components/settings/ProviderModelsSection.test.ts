import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProviderModel,
} from "@t3tools/contracts";

import { Button } from "../ui/button";
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
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(
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
          onHiddenModelsChange: vi.fn(),
          onFavoriteModelsChange: vi.fn(),
          onToggleFavorite: vi.fn(),
          onModelOrderChange: vi.fn(),
        }),
      );
    });

    try {
      expect(renderer!.root.findAllByProps({ "data-model-slug": "pool-model" })).toHaveLength(1);
      expect(
        renderer!.root
          .findAllByType(Button)
          .some(
            (button) =>
              Array.isArray(button.props.children) &&
              button.props.children.includes("Add custom model"),
          ),
      ).toBe(false);
      const bulkToggle = renderer!.root
        .findAllByType(Button)
        .find((button) => button.props.children === "Disable all");
      expect(bulkToggle?.props.disabled).toBe(true);
    } finally {
      await act(async () => renderer?.unmount());
      vi.unstubAllGlobals();
    }
  });
});
