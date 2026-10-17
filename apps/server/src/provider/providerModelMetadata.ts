import {
  ProviderDriverKind,
  type ServerProvider,
  type UsageModelPriceOverride,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ModelManifest from "./ModelManifest.ts";
import type { ModelManifestData } from "./ModelManifest.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageService from "../usage/UsageService.ts";
import { lookupRate, type RateTable } from "../usage/usagePricing.ts";

const openCodeDriver = ProviderDriverKind.make("opencode");

const priceFromRate = (rate: ReturnType<typeof lookupRate>) =>
  rate === null
    ? undefined
    : {
        inputCostPerMillionTokens: rate.inputCostPerToken * 1_000_000,
        outputCostPerMillionTokens: rate.outputCostPerToken * 1_000_000,
      };

function catalogModelsFor(input: {
  readonly provider: ServerProvider;
  readonly manifest: ModelManifestData;
}) {
  return input.manifest.providers?.[input.provider.driver]?.models ?? [];
}

const metadataIndex = (models: ReturnType<typeof catalogModelsFor>) =>
  new Map(
    models.flatMap((entry) =>
      [entry.slug, ...(entry.aliases ?? [])].map((key) => [key, entry] as const),
    ),
  );

const metadataFor = (
  index: ReturnType<typeof metadataIndex>,
  model: ServerProvider["models"][number],
) =>
  model.isCustom
    ? undefined
    : [model.slug, ...(model.aliases ?? [])]
        .map((key) => index.get(key))
        .find((candidate) => candidate !== undefined);

/** Fill runtime snapshots with manifest policy and already-cached rates. */
export function enrichProviderModelMetadata(input: {
  readonly provider: ServerProvider;
  readonly manifest: ModelManifestData;
  readonly fallbackManifest?: ModelManifestData;
  readonly rates: RateTable;
  readonly priceOverrides?: Readonly<Record<string, UsageModelPriceOverride | null>>;
}): ServerProvider {
  const currentMetadata = metadataIndex(catalogModelsFor(input));
  const bundledMetadata = metadataIndex(
    input.fallbackManifest
      ? catalogModelsFor({ provider: input.provider, manifest: input.fallbackManifest })
      : [],
  );
  const models = input.provider.models.map((model) => {
    const entry = metadataFor(currentMetadata, model);
    const fallbackEntry = metadataFor(bundledMetadata, model);
    const override = input.priceOverrides?.[model.slug];
    const manifestPricing = entry?.pricing ?? model.pricing;
    const suffix = model.slug.slice(model.slug.lastIndexOf("/") + 1);
    const cachedPrice = priceFromRate(
      lookupRate(input.rates, model.slug) ??
        (suffix === model.slug ? null : lookupRate(input.rates, suffix)),
    );
    // OpenCode supplies per-model prices itself, including genuine zero rates
    // for free previews. Those explicit API values take precedence over estimates.
    const reportedOpenCodePrice =
      input.provider.driver === openCodeDriver ? model.pricing : undefined;
    const pricing =
      (override
        ? {
            inputCostPerMillionTokens: override.inputCostPerMillionTokens,
            outputCostPerMillionTokens: override.outputCostPerMillionTokens,
          }
        : undefined) ??
      reportedOpenCodePrice ??
      cachedPrice ??
      manifestPricing;
    const defaultSelection =
      entry?.defaultSelection ?? fallbackEntry?.defaultSelection ?? model.defaultSelection;
    return {
      ...model,
      ...(pricing ? { pricing } : {}),
      ...(defaultSelection ? { defaultSelection } : {}),
    };
  });
  return { ...input.provider, models };
}

export const makeProviderModelMetadataEnricher = Effect.gen(function* () {
  const usage = Option.getOrUndefined(yield* Effect.serviceOption(UsageService.UsageService));
  const settings = Option.getOrUndefined(
    yield* Effect.serviceOption(ServerSettings.ServerSettingsService),
  );
  const cachedRates = usage?.cachedRates ?? Effect.succeed(new Map() as RateTable);
  return Effect.fnUntraced(function* (
    providers: ReadonlyArray<ServerProvider>,
    manifest: ModelManifestData,
  ) {
    const rates = yield* cachedRates;
    const currentSettings =
      settings === undefined
        ? undefined
        : yield* settings.getSettings.pipe(Effect.catchCause(() => Effect.succeed(undefined)));
    return providers.map((provider) =>
      enrichProviderModelMetadata({
        provider,
        manifest,
        fallbackManifest: ModelManifest.BUNDLED_MODEL_MANIFEST,
        rates,
        ...(currentSettings ? { priceOverrides: currentSettings.usagePriceOverrides } : {}),
      }),
    );
  });
});
