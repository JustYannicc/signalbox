import type { ModelSelection, ServerProvider } from "@t3tools/contracts";

type InitialModelProvider = Pick<ServerProvider, "instanceId" | "driver"> & {
  readonly models: ReadonlyArray<
    Pick<
      ServerProvider["models"][number],
      "slug" | "aliases" | "isLegacy" | "isDefault" | "pricing" | "defaultSelection"
    >
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

  const candidates = input.providers.flatMap((provider) =>
    provider.models.flatMap((model) => {
      if (model.isLegacy || model.defaultSelection === "excluded") return [];
      const pricing = model.pricing;
      const price =
        pricing &&
        Number.isFinite(pricing.inputCostPerMillionTokens) &&
        pricing.inputCostPerMillionTokens >= 0 &&
        Number.isFinite(pricing.outputCostPerMillionTokens) &&
        pricing.outputCostPerMillionTokens >= 0
          ? pricing.inputCostPerMillionTokens + pricing.outputCostPerMillionTokens
          : null;
      if (
        price === null &&
        model.defaultSelection !== "configured" &&
        model.defaultSelection !== "economical"
      )
        return [];
      return [
        {
          selection: { instanceId: provider.instanceId, model: model.slug },
          price: price ?? Number.POSITIVE_INFINITY,
        },
      ];
    }),
  );
  candidates.sort(
    (left, right) =>
      left.price - right.price ||
      left.selection.model.localeCompare(right.selection.model) ||
      left.selection.instanceId.localeCompare(right.selection.instanceId),
  );
  return candidates[0]?.selection ?? null;
}
