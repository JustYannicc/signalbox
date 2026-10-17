import type { ModelGatewayProvider } from "@signalbox/runner-protocol/RunnerProtocol";
import { PERSONAL_POOL_ID, POOL_INSTANCE_KINDS } from "@t3tools/contracts/accountHub";
import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";

import type { ServedModel } from "../../../pool/cliProxyApi.ts";
import { SCRIPTED_DRIVER } from "../../../thread/scriptedProvider.ts";

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

export const harnessByPoolKind = new Map(
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
 * The pool an instance id names: its suffix, or Personal for `claude_hub` and
 * the plain `claudeAgent` and `codex` instances from before pools. Only trust
 * it on an id the server wrote; a client's names the harness and nothing more.
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
