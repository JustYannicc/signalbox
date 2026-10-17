import {
  DEFAULT_MODEL_BY_PROVIDER,
  type ModelSelection,
  type ProviderDriverKind,
  type ServerProvider,
} from "@t3tools/contracts";

// Catalog order and provider-reported defaults can put a flagship first.
// Only known economical models (or a provider's user-configured default) may
// be selected without an explicit preference.
const ECONOMICAL_MODELS: Readonly<Record<string, ReadonlyArray<string>>> = {
  claudeAgent: ["claude-haiku-5-5", "claude-haiku-4-5", "claude-sonnet-5-5", "claude-sonnet-4-6"],
  codex: ["gpt-6-luna", "gpt-6.1-sol", "gpt-5.4-mini", "gpt-5.1-codex-mini", "gpt-5-mini"],
  cursor: ["auto", "composer-2"],
  opencode: ["openai/gpt-5-mini", "openai/gpt-5.4-mini"],
};

type InitialModelProvider = Pick<ServerProvider, "instanceId" | "driver"> & {
  readonly models: ReadonlyArray<
    Pick<ServerProvider["models"][number], "slug" | "aliases" | "isLegacy">
  >;
};

export function resolveInitialModelSelection(input: {
  readonly projectDefault?: ModelSelection | null | undefined;
  readonly personDefault?: ModelSelection | null | undefined;
  readonly providers: ReadonlyArray<InitialModelProvider>;
}): ModelSelection | null {
  for (const selection of [input.projectDefault, input.personDefault]) {
    if (!selection) continue;
    const model = input.providers
      .find((provider) => provider.instanceId === selection.instanceId)
      ?.models.find((model) => model.slug === selection.model);
    // Preserve a saved choice through sign-out or a temporarily missing catalog.
    if (model?.isLegacy !== true) return selection;
  }
  for (const provider of input.providers) {
    const preferred =
      ECONOMICAL_MODELS[provider.driver] ?? providerDefaultCandidates(provider.driver);
    for (const slug of preferred) {
      const model = provider.models.find(
        (model) => !model.isLegacy && (model.slug === slug || model.aliases?.includes(slug)),
      );
      if (model) return { instanceId: provider.instanceId, model: model.slug };
    }
  }
  return null;
}

function providerDefaultCandidates(driver: ProviderDriverKind): ReadonlyArray<string> {
  const model = DEFAULT_MODEL_BY_PROVIDER[driver];
  return model === undefined ? [] : [model];
}
