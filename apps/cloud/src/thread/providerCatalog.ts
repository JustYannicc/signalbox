import type { ModelGatewayProvider } from "@signalbox/runner-protocol/RunnerProtocol";
import { PERSONAL_POOL_ID, POOL_INSTANCE_KINDS } from "@t3tools/contracts/accountHub";
import {
  DEFAULT_MODEL_BY_PROVIDER,
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import type { ModelManifestCatalogs } from "@t3tools/shared/modelManifest";

import type { ServedModel } from "../pool/cliProxyApi.ts";
import {
  SCRIPTED_DRIVER,
  SCRIPTED_INSTANCE_ID,
  scriptedServerProvider,
} from "./scriptedProvider.ts";

/**
 * The providers a cloud thread can run on. The scripted provider runs inside
 * the thread's own object; Claude Code and Codex run on a machine, driven by
 * the Runner, on a pool's accounts: the cloud offers them only as each pool's
 * instances (`pool/poolViews.ts`).
 *
 * Instance ids match a self-hosted server's, so a thread's model selection
 * means the same thing in either environment. A pool's instance offers the
 * models its CLIProxyAPI serves for the harness's provider, named and given
 * their options by the model manifest (`ModelManifest.ts`).
 */

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const CODEX_DRIVER = ProviderDriverKind.make("codex");

interface HarnessProvider {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  /**
   * The API its harness calls through the ModelGateway. CLIProxyAPI labels
   * the models it serves for that API with the same name (`owned_by`).
   */
  readonly gatewayProvider: ModelGatewayProvider;
}

const HARNESS_PROVIDERS: ReadonlyArray<HarnessProvider> = [
  {
    instanceId: defaultInstanceIdForDriver(CLAUDE_DRIVER),
    driver: CLAUDE_DRIVER,
    gatewayProvider: "anthropic",
  },
  {
    instanceId: defaultInstanceIdForDriver(CODEX_DRIVER),
    driver: CODEX_DRIVER,
    gatewayProvider: "openai",
  },
];

const harnessByInstance = new Map(
  HARNESS_PROVIDERS.map((provider) => [provider.instanceId, provider]),
);

/** The pool instance kinds whose accounts a cloud harness can run on. */
export const CLOUD_POOL_KINDS = ["claude", "codex"] as const;
export type CloudPoolKind = (typeof CLOUD_POOL_KINDS)[number];

const harnessByPoolKind = new Map(
  CLOUD_POOL_KINDS.map((kind) => [
    kind,
    HARNESS_PROVIDERS.find((provider) => provider.driver === POOL_INSTANCE_KINDS[kind].driver)!,
  ]),
);

/** A pool's instance (`claude_hub`, `codex_hub_<poolId>`) runs on its kind's harness. */
const POOL_INSTANCE_PATTERN = /^(claude|codex)_hub(?:_([a-z0-9-]{1,40}))?$/u;

const harnessFor = (instanceId: ProviderInstanceId) => {
  const kind = POOL_INSTANCE_PATTERN.exec(instanceId)?.[1] as CloudPoolKind | undefined;
  return harnessByInstance.get(instanceId) ?? (kind ? harnessByPoolKind.get(kind) : undefined);
};

/**
 * The pool, among its owner's, whose accounts a harness instance's turns run
 * on. Threads from before pools ran on the plain `claudeAgent` and `codex`
 * instances; those run on the owner's personal pool.
 */
export const poolIdOfInstance = (instanceId: ProviderInstanceId): string | undefined => {
  if (harnessFor(instanceId) === undefined) return undefined;
  return POOL_INSTANCE_PATTERN.exec(instanceId)?.[2] ?? PERSONAL_POOL_ID;
};

/** Whether runs on this instance go to a Runner rather than the thread's own object. */
export const isHarnessInstance = (instanceId: ProviderInstanceId) =>
  harnessFor(instanceId) !== undefined;

/**
 * The instance a machine's Runner knows a harness by (`claudeAgent`, `codex`).
 * A pool's instance names the pool, which reaches the gateway in the model
 * token instead; the Runner only needs the harness.
 */
export const runnerInstanceFor = (instanceId: ProviderInstanceId) =>
  harnessFor(instanceId)?.instanceId;

/** The ModelGateway provider a harness instance calls; undefined for anything else. */
export const gatewayProviderFor = (instanceId: ProviderInstanceId) =>
  harnessFor(instanceId)?.gatewayProvider;

/** The driver behind an instance; anything unknown is scripted, the only in-object provider. */
export const driverFor = (instanceId: ProviderInstanceId): ProviderDriverKind =>
  harnessFor(instanceId)?.driver ?? SCRIPTED_DRIVER;

/** The pool kind behind a harness instance; undefined for anything else. */
export const poolKindOfInstance = (instanceId: ProviderInstanceId): CloudPoolKind | undefined => {
  const harness = harnessFor(instanceId);
  return CLOUD_POOL_KINDS.find((kind) => harnessByPoolKind.get(kind) === harness);
};

/** Whether `model` is one a pool serving `served` runs on the harness of `kind`. */
export const servesModel = (
  kind: CloudPoolKind,
  served: ReadonlyArray<ServedModel>,
  model: string,
) =>
  served.some(
    (candidate) =>
      candidate.id === model && candidate.ownedBy === harnessByPoolKind.get(kind)!.gatewayProvider,
  );

/**
 * What a pool offers on the harness of `kind`: the models it serves for the
 * harness's provider, named and given options by the manifest, without the
 * ones the manifest calls legacy. A model the manifest doesn't know yet shows
 * under its slug, with no options. One older than every current model it
 * serves is no newcomer (CLIProxyAPI's catalog reaches back years), so it
 * counts as legacy too.
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
  const currentDates = own.flatMap((model) =>
    entryOf(model.id)?.status === "current" && model.created !== null ? [model.created] : [],
  );
  const oldestCurrent = currentDates.length > 0 ? Math.min(...currentDates) : null;
  const offered = own.filter((model) => {
    const entry = entryOf(model.id);
    if (entry !== undefined) return entry.status === "current";
    return oldestCurrent === null || model.created === null || model.created >= oldestCurrent;
  });
  // Known models in the manifest's order, then newcomers by slug.
  const rank = (slug: string) => entries.get(slug)?.index ?? Number.MAX_SAFE_INTEGER;
  const ordered = offered.toSorted(
    (left, right) => rank(left.id) - rank(right.id) || left.id.localeCompare(right.id),
  );
  const slugs = ordered.map((model) => model.id);
  const defaultSlug =
    [catalog?.defaults?.chat, DEFAULT_MODEL_BY_PROVIDER[harness.driver]].find(
      (slug) => slug !== undefined && slugs.includes(slug),
    ) ?? slugs[0];
  return ordered.map((model): ServerProviderModel => {
    const entry = entryOf(model.id);
    const profile = entry?.profile === undefined ? undefined : catalog?.profiles[entry.profile];
    return {
      slug: model.id,
      name: entry?.name ?? model.id,
      ...(entry?.shortName ? { shortName: entry.shortName } : {}),
      ...(entry?.subProvider ? { subProvider: entry.subProvider } : {}),
      ...(entry?.aliases ? { aliases: entry.aliases } : {}),
      ...(entry?.badge ? { badge: entry.badge } : {}),
      isCustom: false,
      ...(model.id === defaultSlug ? { isDefault: true } : {}),
      capabilities: profile?.capabilities ?? null,
    };
  });
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
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly checkedAt: string;
}): ServerProvider => {
  const harness = harnessByPoolKind.get(input.kind)!;
  const ready = input.signedIn && input.models.length > 0;
  return {
    instanceId: input.instanceId,
    driver: harness.driver,
    displayName: input.displayName,
    badgeLabel: "Preview",
    showInteractionModeToggle: false,
    supportsConversationRollback: false,
    supportsTextGeneration: false,
    enabled: true,
    installed: true,
    version: null,
    // Signed out, clients say to add an account to the pool (`ProviderStatusBanner`).
    status: ready ? "ready" : input.signedIn ? "warning" : "error",
    ...(input.signedIn && !ready
      ? { message: "This pool's accounts serve no models right now. Try again shortly." }
      : {}),
    auth: { status: input.signedIn ? "authenticated" : "unauthenticated" },
    checkedAt: input.checkedAt,
    availability: "available",
    models: input.signedIn ? input.models : [],
    slashCommands: [],
    skills: [],
  };
};
