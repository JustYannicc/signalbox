import {
  ProviderDriverKind,
  type ModelCapabilities,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { getProviderModelCapabilities } from "./providerModels";

const PROVIDER = ProviderDriverKind.make("claudeAgent");
const CODEX = ProviderDriverKind.make("codex");

function capabilities(id: string): ModelCapabilities {
  return {
    optionDescriptors: [{ id, label: id, type: "boolean" }],
  };
}

function model(input: {
  slug: string;
  capabilities: ModelCapabilities;
  aliases?: ReadonlyArray<string>;
  isCustom?: boolean;
}): ServerProviderModel {
  return {
    slug: input.slug,
    name: input.slug,
    ...(input.aliases ? { aliases: [...input.aliases] } : {}),
    isCustom: input.isCustom ?? false,
    capabilities: input.capabilities,
  };
}

describe("getProviderModelCapabilities", () => {
  it("resolves model-declared aliases", () => {
    const aliasCapabilities = capabilities("aliased-option");
    const models = [
      model({
        slug: "synthetic-model",
        aliases: ["Legacy-Synthetic-Model"],
        capabilities: aliasCapabilities,
      }),
    ];

    expect(getProviderModelCapabilities(models, "legacy-synthetic-model", PROVIDER)).toEqual(
      aliasCapabilities,
    );
  });

  it("prefers an exact custom slug over a built-in model alias", () => {
    const customCapabilities = capabilities("custom-option");
    const models = [
      model({
        slug: "synthetic-model",
        aliases: ["custom-model"],
        capabilities: capabilities("built-in-option"),
      }),
      model({ slug: "custom-model", capabilities: customCapabilities, isCustom: true }),
    ];

    expect(getProviderModelCapabilities(models, " custom-model ", PROVIDER)).toEqual(
      customCapabilities,
    );
  });

  it("returns empty capabilities for an unknown slug", () => {
    const models = [
      model({
        slug: "default-model",
        capabilities: capabilities("default-option"),
      }),
    ];

    expect(getProviderModelCapabilities(models, "unknown-model", PROVIDER)).toEqual({
      optionDescriptors: [],
    });
  });

  it("uses the exact served record for a future ID that matches a local alias", () => {
    const poolCapabilities = capabilities("pool-effort");
    const localCapabilities = capabilities("local-effort");
    const models = [
      model({ slug: "gpt-5-codex", capabilities: poolCapabilities }),
      model({ slug: "gpt-5.4", capabilities: localCapabilities }),
    ];

    expect(getProviderModelCapabilities(models, "gpt-5-codex", CODEX)).toEqual(poolCapabilities);
  });
});
