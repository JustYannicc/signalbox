import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { BUNDLED_MODEL_CATALOGS } from "./ModelManifest.ts";
import { harnessModels, poolIdOfInstance, runnerInstanceFor } from "./providerCatalog.ts";

describe("poolIdOfInstance", () => {
  it("names the pool a harness turn runs on", () => {
    const poolOf = (id: string) => poolIdOfInstance(ProviderInstanceId.make(id));
    expect(poolOf("claude_hub")).toBe("personal");
    expect(poolOf("codex_hub_work-2")).toBe("work-2");
    // Threads from before pools ran on the plain instances, now Personal's.
    expect(poolOf("claudeAgent")).toBe("personal");
    expect(poolOf("codex")).toBe("personal");
    // Not a harness: the scripted provider, and kinds the cloud can't run.
    expect(poolOf("scripted")).toBeUndefined();
    expect(poolOf("grok_hub_work")).toBeUndefined();
  });
});

describe("runnerInstanceFor", () => {
  it("hands the Runner the harness, never the pool", () => {
    const runnerOf = (id: string) => runnerInstanceFor(ProviderInstanceId.make(id));
    expect(runnerOf("codex_hub")).toBe("codex");
    expect(runnerOf("claude_hub_work-2")).toBe("claudeAgent");
    expect(runnerOf("scripted")).toBeUndefined();
  });
});

describe("harnessModels", () => {
  const served = (ownedBy: string, ...models: ReadonlyArray<[string, number | null]>) =>
    models.map(([id, created]) => ({ id, ownedBy, created }));
  const claude = served(
    "anthropic",
    ["claude-sonnet-5-5", 1_790_553_600],
    ["claude-opus-5-5", 1_790_035_200],
    ["claude-fable-5-1", 1_788_220_800],
  );

  it("offers only the pool's models, with fallback names and a served default", () => {
    const models = harnessModels(
      "claude",
      [...claude, ...served("openai", ["gpt-6.1-sol", 1_790_640_000])],
      BUNDLED_MODEL_CATALOGS,
    );
    // Catalog order stays intact; only economical models become defaults.
    expect(models.map((model) => [model.slug, model.name, model.isDefault ?? false])).toEqual([
      ["claude-opus-5-5", "Claude Opus 5.5", false],
      ["claude-sonnet-5-5", "Claude Sonnet 5.5", true],
      ["claude-fable-5-1", "Claude Fable 5.1", false],
    ]);
    // Codex gets what its accounts serve, which the hardcoded list missed.
    expect(
      harnessModels(
        "codex",
        served("openai", ["gpt-6.1-sol", 1_790_640_000]),
        BUNDLED_MODEL_CATALOGS,
      ),
    ).toEqual([
      {
        slug: "gpt-6.1-sol",
        name: "GPT-6.1 Sol",
        isCustom: false,
        isDefault: true,
        capabilities: null,
      },
    ]);
  });

  it("shows a model the manifest doesn't know yet under its slug, with no options", () => {
    const models = harnessModels(
      "claude",
      [
        ...claude,
        ...served("anthropic", ["claude-zephyr-6", 1_800_000_000], ["claude-dawn", null]),
      ],
      BUNDLED_MODEL_CATALOGS,
    );
    expect(
      models.filter((model) => model.slug.includes("zephyr") || model.slug === "claude-dawn"),
    ).toEqual([
      { slug: "claude-dawn", name: "claude-dawn", isCustom: false, capabilities: null },
      { slug: "claude-zephyr-6", name: "claude-zephyr-6", isCustom: false, capabilities: null },
    ]);
  });

  it("keeps every served model even when the manifest calls it old or does not know it", () => {
    const models = harnessModels(
      "claude",
      [
        ...claude,
        ...served(
          "anthropic",
          ["claude-opus-5", 1_784_038_800],
          ["claude-3-7-sonnet-20250219", 1_708_300_800],
        ),
      ],
      BUNDLED_MODEL_CATALOGS,
    );
    expect(models.map((model) => model.slug)).toEqual([
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-fable-5-1",
      "claude-3-7-sonnet-20250219",
      "claude-opus-5",
    ]);
  });

  it("maps a new pool model's name and reasoning levels to the harness options", () => {
    const models = harnessModels(
      "codex",
      [
        {
          id: "new-research-model",
          ownedBy: "openai",
          created: 1,
          provider: "codex",
          displayName: "New research model",
          reasoningEfforts: ["low", "medium", "future-effort"],
        },
      ],
      BUNDLED_MODEL_CATALOGS,
    );
    expect(models).toEqual([
      {
        slug: "new-research-model",
        name: "New research model",
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            {
              id: "reasoningEffort",
              label: "Reasoning",
              type: "select",
              currentValue: "medium",
              options: [
                { id: "low", label: "Low" },
                { id: "medium", label: "Medium", isDefault: true },
                { id: "future-effort", label: "future-effort" },
              ],
            },
          ],
        },
      },
    ]);
  });

  it("uses the Claude harness's effort key and keeps its established fast control", () => {
    const [model] = harnessModels(
      "claude",
      [
        {
          id: "claude-opus-5-5",
          ownedBy: "anthropic",
          created: null,
          reasoningEfforts: ["low", "high"],
        },
      ],
      BUNDLED_MODEL_CATALOGS,
    );
    expect(model?.capabilities?.optionDescriptors).toEqual([
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        currentValue: "low",
        options: [
          { id: "low", label: "Low", isDefault: true },
          { id: "high", label: "High" },
        ],
      },
      { id: "fastMode", label: "Fast Mode", type: "boolean" },
    ]);
  });

  it("never adds a manifest model the pool does not serve", () => {
    const models = harnessModels(
      "codex",
      served("openai", ["new-research-model", 1]),
      BUNDLED_MODEL_CATALOGS,
    );
    expect(models.map((model) => model.slug)).toEqual(["new-research-model"]);
    expect(models[0]?.isDefault).toBeUndefined();
    expect(harnessModels("claude", [], BUNDLED_MODEL_CATALOGS)).toEqual([]);
  });
});
