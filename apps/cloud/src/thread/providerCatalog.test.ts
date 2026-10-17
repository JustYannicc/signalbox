import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { BUNDLED_MODEL_CATALOGS } from "./ModelManifest.ts";
import {
  harnessModels,
  poolIdOfInstance,
  poolServerProvider,
  runnerInstanceFor,
} from "./providerCatalog.ts";

describe("poolServerProvider", () => {
  it.each(["claude", "codex"] as const)("allows plan questions for the %s harness", (kind) => {
    const provider = poolServerProvider({
      kind,
      instanceId: ProviderInstanceId.make(`${kind}_hub`),
      displayName: kind,
      signedIn: true,
      models: [],
      checkedAt: "2026-10-17T11:24:00.000Z",
    });
    expect(provider.showInteractionModeToggle).toBe(true);
  });
});

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

  it("offers what the pool serves for the harness, named and given options by the manifest", () => {
    const models = harnessModels(
      "claude",
      [...claude, ...served("openai", ["gpt-6.1-sol", 1_790_640_000])],
      BUNDLED_MODEL_CATALOGS,
    );
    // The manifest's order, its names, and its chat default.
    expect(models.map((model) => [model.slug, model.name, model.isDefault ?? false])).toEqual([
      ["claude-opus-5-5", "Claude Opus 5.5", false],
      ["claude-sonnet-5-5", "Claude Sonnet 5.5", false],
      ["claude-fable-5-1", "Claude Fable 5.1", true],
    ]);
    const effort = models[0]?.capabilities?.optionDescriptors?.find(
      (option) => option.id === "effort",
    );
    expect(effort?.type === "select" && effort.options.map((option) => option.id)).toContain(
      "xhigh",
    );
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

  it("hides legacy models, and unknown ones older than every current model", () => {
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
    ]);
  });
});
