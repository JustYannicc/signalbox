import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { parseRateTable } from "../usage/usagePricing.ts";
import type { ModelManifestData } from "./ModelManifest.ts";
import { enrichProviderModelMetadata } from "./providerModelMetadata.ts";

const manifest: ModelManifestData = {
  version: 1,
  currentModels: {},
  providers: {
    codex: {
      profiles: {},
      models: [
        {
          slug: "catalog-luna",
          name: "Catalog Luna",
          aliases: ["gpt-6-luna"],
          status: "current",
          pricing: { inputCostPerMillionTokens: 5, outputCostPerMillionTokens: 10 },
          defaultSelection: "economical",
        },
        {
          slug: "flagship",
          name: "Flagship",
          status: "current",
          defaultSelection: "excluded",
        },
      ],
    },
    opencode: {
      profiles: {},
      models: [],
    },
  },
};

const provider = (
  driver: "codex" | "opencode",
  models: ServerProvider["models"],
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(driver),
  driver: ProviderDriverKind.make(driver),
  displayName: driver,
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-17T00:00:00.000Z",
  models,
  slashCommands: [],
  skills: [],
});

const model = (slug: string, overrides: Partial<ServerProvider["models"][number]> = {}) => ({
  slug,
  name: slug,
  isCustom: false,
  capabilities: null,
  ...overrides,
});

it("adds catalog policy, prefers cached rates over manifest fallback and honors overrides", () => {
  const rates = parseRateTable({
    "gpt-6-luna": { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 },
  });
  const enriched = enrichProviderModelMetadata({
    provider: provider("codex", [model("gpt-6-luna"), model("flagship")]),
    manifest,
    rates,
  });
  assert.deepStrictEqual(enriched.models, [
    {
      ...model("gpt-6-luna"),
      pricing: { inputCostPerMillionTokens: 1, outputCostPerMillionTokens: 2 },
      defaultSelection: "economical",
    },
    { ...model("flagship"), defaultSelection: "excluded" },
  ]);

  const overridden = enrichProviderModelMetadata({
    provider: provider("codex", [model("gpt-6-luna")]),
    manifest,
    rates,
    priceOverrides: {
      "gpt-6-luna": { inputCostPerMillionTokens: 0, outputCostPerMillionTokens: 0 },
    },
  });
  assert.deepStrictEqual(overridden.models[0]?.pricing, {
    inputCostPerMillionTokens: 0,
    outputCostPerMillionTokens: 0,
  });
});

it("keeps OpenCode's reported zero as a real free model price", () => {
  const enriched = enrichProviderModelMetadata({
    provider: provider("opencode", [
      model("opencode/free", {
        pricing: { inputCostPerMillionTokens: 0, outputCostPerMillionTokens: 0 },
      }),
    ]),
    manifest,
    rates: parseRateTable({
      "opencode/free": { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 },
    }),
  });
  assert.deepStrictEqual(enriched.models[0]?.pricing, {
    inputCostPerMillionTokens: 0,
    outputCostPerMillionTokens: 0,
  });
});

it("falls back to bundled selection policy when a newer manifest omits it", () => {
  const refreshedManifest: ModelManifestData = {
    version: 1,
    updatedAt: "2099-01-01T00:00:00Z",
    currentModels: {},
    providers: {
      codex: {
        profiles: {},
        models: [
          { slug: "flagship", name: "Flagship", status: "current" },
          {
            slug: "catalog-luna",
            name: "Catalog Luna",
            status: "current",
            defaultSelection: "configured",
          },
        ],
      },
    },
  };
  const enriched = enrichProviderModelMetadata({
    provider: provider("codex", [model("flagship"), model("catalog-luna")]),
    manifest: refreshedManifest,
    fallbackManifest: manifest,
    rates: parseRateTable({}),
  });
  assert.deepStrictEqual(
    enriched.models.map(({ defaultSelection }) => defaultSelection),
    ["excluded", "configured"],
  );
});
