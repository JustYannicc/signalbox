import type { ModelGatewayProvider } from "@signalbox/runner-protocol/RunnerProtocol";
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
 * the Runner, so the cloud offers them only when it has a machine backend.
 *
 * Instance ids match a self-hosted server's defaults, so a thread's model
 * selection means the same thing in either environment.
 */

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const CODEX_DRIVER = ProviderDriverKind.make("codex");

interface HarnessProvider {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly displayName: string;
  /** The API its harness calls through the ModelGateway. */
  readonly gatewayProvider: ModelGatewayProvider;
  readonly models: ReadonlyArray<{ readonly slug: string; readonly name: string }>;
}

/** The models offered until the Runner reports what its pinned CLIs support (#17). */
const HARNESS_PROVIDERS: ReadonlyArray<HarnessProvider> = [
  {
    instanceId: defaultInstanceIdForDriver(CLAUDE_DRIVER),
    driver: CLAUDE_DRIVER,
    displayName: "Claude",
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
    displayName: "Codex",
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

/** Whether runs on this instance go to a Runner rather than the thread's own object. */
export const isHarnessInstance = (instanceId: ProviderInstanceId) =>
  harnessByInstance.has(instanceId);

/** The ModelGateway provider a harness instance calls; undefined for anything else. */
export const gatewayProviderFor = (instanceId: ProviderInstanceId) =>
  harnessByInstance.get(instanceId)?.gatewayProvider;

/** The driver behind an instance; anything unknown is scripted, the only in-object provider. */
export const driverFor = (instanceId: ProviderInstanceId): ProviderDriverKind =>
  harnessByInstance.get(instanceId)?.driver ?? SCRIPTED_DRIVER;

const harnessServerProvider = (provider: HarnessProvider, checkedAt: string): ServerProvider => ({
  instanceId: provider.instanceId,
  driver: provider.driver,
  displayName: provider.displayName,
  badgeLabel: "Preview",
  showInteractionModeToggle: false,
  supportsConversationRollback: false,
  supportsTextGeneration: false,
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
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

/** What the cloud advertises. `harnesses`: whether a machine backend can run Claude and Codex. */
export const cloudProviders = (input: {
  readonly checkedAt: string;
  readonly harnesses: boolean;
}): ReadonlyArray<ServerProvider> => [
  scriptedServerProvider(input.checkedAt),
  ...(input.harnesses
    ? HARNESS_PROVIDERS.map((provider) => harnessServerProvider(provider, input.checkedAt))
    : []),
];

/** Settings list an instance for clients to enable it. */
export const cloudProviderInstances = (harnesses: boolean) =>
  Object.fromEntries([
    [SCRIPTED_INSTANCE_ID, { driver: SCRIPTED_DRIVER, enabled: true }],
    ...(harnesses
      ? HARNESS_PROVIDERS.map((provider) => [
          provider.instanceId,
          { driver: provider.driver, enabled: true },
        ])
      : []),
  ]);
