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
 * means the same thing in either environment.
 */

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const CODEX_DRIVER = ProviderDriverKind.make("codex");

interface HarnessProvider {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  /** The API its harness calls through the ModelGateway. */
  readonly gatewayProvider: ModelGatewayProvider;
  readonly models: ReadonlyArray<{ readonly slug: string; readonly name: string }>;
}

/** The models offered until the Runner reports what its pinned CLIs support (#17). */
const HARNESS_PROVIDERS: ReadonlyArray<HarnessProvider> = [
  {
    instanceId: defaultInstanceIdForDriver(CLAUDE_DRIVER),
    driver: CLAUDE_DRIVER,
    gatewayProvider: "anthropic",
    models: [
      { slug: "claude-fable-5-1", name: "Claude Fable 5.1" },
      { slug: "claude-opus-5-5", name: "Claude Opus 5.5" },
      { slug: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
    ],
  },
  {
    instanceId: defaultInstanceIdForDriver(CODEX_DRIVER),
    driver: CODEX_DRIVER,
    gatewayProvider: "openai",
    models: [
      { slug: "gpt-6-astra", name: "GPT-6 Astra" },
      { slug: "gpt-6-luna", name: "GPT-6 Luna" },
    ],
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

/** The ModelGateway provider a harness instance calls; undefined for anything else. */
export const gatewayProviderFor = (instanceId: ProviderInstanceId) =>
  harnessFor(instanceId)?.gatewayProvider;

/** The driver behind an instance; anything unknown is scripted, the only in-object provider. */
export const driverFor = (instanceId: ProviderInstanceId): ProviderDriverKind =>
  harnessFor(instanceId)?.driver ?? SCRIPTED_DRIVER;

const harnessServerProvider = (
  provider: HarnessProvider,
  checkedAt: string,
  instance: {
    readonly instanceId: ProviderInstanceId;
    readonly displayName: string;
    readonly auth: ServerProvider["auth"];
  },
): ServerProvider => ({
  instanceId: instance.instanceId,
  driver: provider.driver,
  displayName: instance.displayName,
  badgeLabel: "Preview",
  showInteractionModeToggle: false,
  supportsConversationRollback: false,
  supportsTextGeneration: false,
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: instance.auth,
  checkedAt,
  availability: "available",
  models: provider.models.map((model): ServerProviderModel => ({
    slug: model.slug,
    name: model.name,
    isCustom: false,
    isDefault: model.slug === DEFAULT_MODEL_BY_PROVIDER[provider.driver],
    capabilities: null,
  })),
  slashCommands: [],
  skills: [],
});

/** What the cloud advertises besides the pools' instances. */
export const cloudProviders = (checkedAt: string): ReadonlyArray<ServerProvider> => [
  scriptedServerProvider(checkedAt),
];

/** Settings list an instance for clients to enable it. */
export const cloudProviderInstances = () => ({
  [SCRIPTED_INSTANCE_ID]: { driver: SCRIPTED_DRIVER, enabled: true },
});

/**
 * A pool's instance of `kind`, offered whether or not the cloud has a machine
 * backend: accounts sign in through the pool, not a machine. Signed out until
 * the pool holds an account of that kind.
 */
export const poolServerProvider = (input: {
  readonly kind: CloudPoolKind;
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string;
  readonly signedIn: boolean;
  readonly checkedAt: string;
}): ServerProvider =>
  harnessServerProvider(harnessByPoolKind.get(input.kind)!, input.checkedAt, {
    instanceId: input.instanceId,
    displayName: input.displayName,
    auth: { status: input.signedIn ? "authenticated" : "unauthenticated" },
  });
