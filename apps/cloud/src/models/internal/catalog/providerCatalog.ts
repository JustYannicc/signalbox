import { resolveInitialModelSelection } from "@t3tools/shared/defaultModelSelection";
import type { ProviderInstanceId, ServerProvider, ServerProviderModel } from "@t3tools/contracts";
import type { ModelManifestCatalogs } from "@t3tools/shared/modelManifest";

import type { ServedModel } from "../../../pool/cliProxyApi.ts";
import { harnessByPoolKind, type CloudPoolKind } from "./routing.ts";
import { poolModelCapabilities } from "./poolModelCapabilities.ts";
import {
  SCRIPTED_DRIVER,
  SCRIPTED_INSTANCE_ID,
  scriptedServerProvider,
} from "../../../thread/scriptedProvider.ts";

/**
 * What a pool offers on the harness of `kind`. Only the pool decides which
 * models exist; the manifest supplies fallback labels and defaults.
 */
export const harnessModels = (
  kind: CloudPoolKind,
  served: ReadonlyArray<ServedModel>,
  manifest: ModelManifestCatalogs,
): ReadonlyArray<ServerProviderModel> => {
  const harness = harnessByPoolKind.get(kind)!;
  const catalog = manifest.providers?.[harness.driver];
  // Each entry by its slug and aliases, with its place in the manifest.
  const entries = new Map(
    (catalog?.models ?? []).flatMap((entry, index) =>
      [entry.slug, ...(entry.aliases ?? [])].map((slug) => [slug, { entry, index }] as const),
    ),
  );
  const entryOf = (slug: string) => entries.get(slug)?.entry;
  const own = served.filter((model) => model.ownedBy === harness.gatewayProvider);
  // Known models in the manifest's order, then newcomers by slug.
  const rank = (slug: string) => entries.get(slug)?.index ?? Number.MAX_SAFE_INTEGER;
  const ordered = own.toSorted(
    (left, right) => rank(left.id) - rank(right.id) || left.id.localeCompare(right.id),
  );
  const models = ordered.map((model): ServerProviderModel => {
    const entry = entryOf(model.id);
    const profile = entry?.profile === undefined ? undefined : catalog?.profiles[entry.profile];
    return {
      slug: model.id,
      name: model.displayName ?? entry?.name ?? model.id,
      ...(entry?.shortName ? { shortName: entry.shortName } : {}),
      ...(entry?.subProvider ? { subProvider: entry.subProvider } : {}),
      ...(entry?.aliases ? { aliases: entry.aliases } : {}),
      ...(entry?.badge ? { badge: entry.badge } : {}),
      ...(entry?.pricing ? { pricing: entry.pricing } : {}),
      ...(entry?.defaultSelection ? { defaultSelection: entry.defaultSelection } : {}),
      ...(entry?.status === "legacy" ? { isLegacy: true } : {}),
      isCustom: false,
      capabilities: poolModelCapabilities(kind, model, profile?.capabilities),
    };
  });
  const defaultSlug = resolveInitialModelSelection({
    providers: [{ instanceId: harness.instanceId, driver: harness.driver, models }],
  })?.model;
  return models.map((model) =>
    model.slug === defaultSlug ? { ...model, isDefault: true } : model,
  );
};

/** What the cloud advertises besides the pools' instances: the scripted provider, when on. */
export const cloudProviders = (
  checkedAt: string,
  options: { readonly scripted: boolean },
): ReadonlyArray<ServerProvider> => (options.scripted ? [scriptedServerProvider(checkedAt)] : []);

/** Settings list an instance for clients to enable it. */
export const cloudProviderInstances = (options: { readonly scripted: boolean }) =>
  options.scripted ? { [SCRIPTED_INSTANCE_ID]: { driver: SCRIPTED_DRIVER, enabled: true } } : {};

/**
 * A pool's instance of `kind`, offered whether or not the cloud has a machine
 * backend: accounts sign in through the pool, not a machine. Signed out until
 * the pool holds an account of that kind; then it offers `models`.
 */
export const poolServerProvider = (input: {
  readonly kind: CloudPoolKind;
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string;
  readonly signedIn: boolean;
  readonly unavailableReason?: string | undefined;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly checkedAt: string;
}): ServerProvider => {
  const harness = harnessByPoolKind.get(input.kind)!;
  const ready = input.signedIn && input.models.length > 0;
  const message =
    input.unavailableReason ??
    (input.signedIn && !ready
      ? "This pool's accounts serve no models right now. Try again shortly."
      : undefined);
  return {
    instanceId: input.instanceId,
    driver: harness.driver,
    displayName: input.displayName,
    badgeLabel: "Preview",
    showInteractionModeToggle: false,
    supportsConversationRollback: true,
    supportsTextGeneration: false,
    enabled: true,
    installed: true,
    version: null,
    // An accounts read can fail while cached accounts still serve the cached models.
    status:
      ready && input.unavailableReason === undefined
        ? "ready"
        : input.signedIn
          ? "warning"
          : "error",
    ...(message === undefined ? {} : { message }),
    auth: {
      status:
        !input.signedIn && input.unavailableReason
          ? "unknown"
          : input.signedIn
            ? "authenticated"
            : "unauthenticated",
    },
    ...(input.unavailableReason === undefined
      ? {}
      : { unavailableReason: input.unavailableReason }),
    checkedAt: input.checkedAt,
    availability: "available",
    models: input.signedIn || input.unavailableReason ? input.models : [],
    slashCommands: [],
    skills: [],
  };
};
