import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { resolveInitialModelSelection } from "./defaultModelSelection.ts";

const instanceId = ProviderInstanceId.make("claude_hub");
const providers = [
  {
    instanceId,
    driver: ProviderDriverKind.make("claudeAgent"),
    models: [
      { slug: "claude-fable-5-1", name: "Fable", isDefault: true },
      { slug: "claude-opus-5-5", name: "Opus" },
      { slug: "claude-haiku-5-5", name: "Haiku" },
    ],
  },
];
const projectDefault = {
  instanceId,
  model: "claude-opus-5-5",
  options: [{ id: "effort", value: "high" }],
};
const personDefault = { instanceId, model: "claude-fable-5-1" };

describe("resolveInitialModelSelection", () => {
  it("honors the folder before the person, preserving explicit expensive choices and options", () => {
    expect(resolveInitialModelSelection({ projectDefault, personDefault, providers })).toBe(
      projectDefault,
    );
    expect(resolveInitialModelSelection({ personDefault, providers })).toBe(personDefault);
  });

  it("ignores catalog order and flagship default flags without preferences", () => {
    expect(resolveInitialModelSelection({ providers })).toEqual({
      instanceId,
      model: "claude-haiku-5-5",
    });
    expect(
      resolveInitialModelSelection({
        providers: providers.map((p) => ({ ...p, models: p.models.toReversed() })),
      }),
    ).toEqual({ instanceId, model: "claude-haiku-5-5" });
  });

  it("leaves selection empty if a catalog only has expensive or unknown models", () => {
    expect(
      resolveInitialModelSelection({
        providers: providers.map((p) => ({ ...p, models: p.models.slice(0, 2) })),
      }),
    ).toBeNull();
    expect(resolveInitialModelSelection({ providers: [] })).toBeNull();
  });

  it("preserves preferences while a provider is offline or a custom model is absent", () => {
    expect(resolveInitialModelSelection({ projectDefault, personDefault, providers: [] })).toBe(
      projectDefault,
    );
  });

  it("skips a retired folder default before considering the person", () => {
    const retired = { ...projectDefault, model: "retired" };
    const catalog = providers.map((p) => ({
      ...p,
      models: [...p.models, { slug: "retired", name: "Retired", isLegacy: true }],
    }));
    expect(
      resolveInitialModelSelection({ projectDefault: retired, personDefault, providers: catalog }),
    ).toBe(personDefault);
  });

  it.each([
    ["cursor", "auto"],
    ["pi", "default"],
    ["muse", "default"],
    ["acpRegistry", "default"],
    ["antigravity", "antigravity-default"],
    ["grok", "grok-build"],
    ["opencode", "openai/gpt-5-mini"],
  ])("uses %s's economical or user-configured default", (driver, model) => {
    const provider = {
      instanceId: ProviderInstanceId.make(driver),
      driver: ProviderDriverKind.make(driver),
      models: [
        { slug: "flagship", name: "Flagship", isDefault: true },
        { slug: model, name: model },
      ],
    };
    expect(resolveInitialModelSelection({ providers: [provider] })).toEqual({
      instanceId: provider.instanceId,
      model,
    });
  });

  it("uses Luna even when Codex advertises Astra as default", () => {
    const codex = {
      instanceId: ProviderInstanceId.make("codex"),
      driver: ProviderDriverKind.make("codex"),
      models: [
        { slug: "gpt-6-astra", name: "Astra", isDefault: true },
        { slug: "gpt-6-luna", name: "Luna" },
      ],
    };
    expect(resolveInitialModelSelection({ providers: [codex] })).toEqual({
      instanceId: codex.instanceId,
      model: "gpt-6-luna",
    });
    expect(
      resolveInitialModelSelection({ providers: [{ ...codex, models: codex.models.slice(0, 1) }] }),
    ).toBeNull();
  });
});
