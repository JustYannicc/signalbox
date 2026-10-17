import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { resolveInitialModelSelection } from "./defaultModelSelection.ts";

const instanceId = ProviderInstanceId.make("provider");
const providers = [
  {
    instanceId,
    driver: ProviderDriverKind.make("claudeAgent"),
    models: [
      {
        slug: "flagship",
        isDefault: true,
        defaultSelection: "excluded" as const,
        pricing: { inputCostPerMillionTokens: 20, outputCostPerMillionTokens: 100 },
      },
      {
        slug: "balanced",
        pricing: { inputCostPerMillionTokens: 3, outputCostPerMillionTokens: 15 },
      },
      {
        slug: "economy",
        pricing: { inputCostPerMillionTokens: 1, outputCostPerMillionTokens: 5 },
      },
    ],
  },
];
const projectDefault = {
  instanceId,
  model: "balanced",
  options: [{ id: "effort", value: "high" }],
};
const personDefault = { instanceId, model: "flagship" };

describe("resolveInitialModelSelection", () => {
  it("honors the folder before the person, preserving explicit expensive choices and options", () => {
    expect(resolveInitialModelSelection({ projectDefault, personDefault, providers })).toBe(
      projectDefault,
    );
    expect(resolveInitialModelSelection({ personDefault, providers })).toBe(personDefault);
  });

  it("uses catalog prices instead of slug, order or provider default flags", () => {
    const selected = { instanceId, model: "economy" };
    expect(resolveInitialModelSelection({ providers })).toEqual(selected);
    expect(
      resolveInitialModelSelection({
        providers: providers.map((provider) => ({
          ...provider,
          models: provider.models.toReversed(),
        })),
      }),
    ).toEqual(selected);
  });

  it("discovers a new cheap or free model from metadata without a code release", () => {
    const free = {
      slug: "opencode/step-5-preview-free",
      pricing: { inputCostPerMillionTokens: 0, outputCostPerMillionTokens: 0 },
    };
    const provider = {
      ...providers[0]!,
      driver: ProviderDriverKind.make("opencode"),
      models: [...providers[0]!.models, free],
    };
    expect(resolveInitialModelSelection({ providers: [provider] })).toEqual({
      instanceId,
      model: free.slug,
    });
    const cheaper = {
      slug: "future-economy",
      pricing: { inputCostPerMillionTokens: 0.1, outputCostPerMillionTokens: 0.2 },
    };
    expect(
      resolveInitialModelSelection({
        providers: [{ ...providers[0]!, models: [...providers[0]!.models, cheaper] }],
      }),
    ).toEqual({ instanceId, model: cheaper.slug });
  });

  it("requires a choice for excluded flagships or unknown prices", () => {
    expect(
      resolveInitialModelSelection({
        providers: [
          {
            ...providers[0]!,
            models: [providers[0]!.models[0]!, { slug: "unpriced", isDefault: true }],
          },
        ],
      }),
    ).toBeNull();
    expect(resolveInitialModelSelection({ providers: [] })).toBeNull();
  });

  it("preserves saved preferences while a provider catalog is temporarily missing", () => {
    expect(resolveInitialModelSelection({ projectDefault, personDefault, providers: [] })).toBe(
      projectDefault,
    );
  });

  it("skips a retired folder default before considering the person", () => {
    const retired = { ...projectDefault, model: "retired" };
    const catalog = providers.map((provider) => ({
      ...provider,
      models: [...provider.models, { slug: "retired", isLegacy: true }],
    }));
    expect(
      resolveInitialModelSelection({ projectDefault: retired, personDefault, providers: catalog }),
    ).toBe(personDefault);
  });

  it("can defer to a provider's explicitly configured session default", () => {
    expect(
      resolveInitialModelSelection({
        providers: [
          { ...providers[0]!, models: [{ slug: "session", defaultSelection: "configured" }] },
        ],
      }),
    ).toEqual({ instanceId, model: "session" });
  });

  it("uses maintained economical metadata while prices are unavailable", () => {
    expect(
      resolveInitialModelSelection({
        providers: [
          {
            ...providers[0]!,
            models: [{ slug: "offline-economy", defaultSelection: "economical" }],
          },
        ],
      }),
    ).toEqual({ instanceId, model: "offline-economy" });
  });
});
