import * as NodeServices from "@effect/platform-node/NodeServices";
import { type ProviderInstanceId, defaultInstanceIdForDriver } from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../../config.ts";
import * as ProviderEventLoggers from "../../provider/ProviderEventLoggers.ts";
import {
  ClaudeAdapterV2Driver,
  layerQueryRunner as layerClaudeQueryRunner,
} from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import {
  CodexAdapterV2Driver,
  layerAppServerClientFactory as layerCodexClientFactory,
} from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as IdAllocator from "../../orchestration-v2/IdAllocator.ts";
import type { ProviderAdapterV2Shape } from "../../orchestration-v2/ProviderAdapter.ts";
import {
  claudeSettings,
  codexSettings,
  harnessEnvironment,
  machineLayout,
  prepareMachine,
} from "./RunnerModelAccess.ts";

/**
 * The provider adapters a Runner drives, built by upstream's own adapter
 * drivers (`ClaudeAdapterV2Driver`, `CodexAdapterV2Driver`): the stock CLIs on
 * PATH, configured to reach their models through the ModelGateway rather than
 * any login or key on this machine (see `RunnerModelAccess.ts`). Only the
 * services those constructors ask for are provided, not the server's layer
 * graph, so the Runner carries no settings store, MCP server or session
 * database, and an upstream change to an adapter reaches the Runner through a
 * normal merge.
 */

/**
 * What the adapter constructors need. The server config only supplies paths
 * under `home`; the adapters read nothing else from it. `environment` is all
 * of the host's environment the harnesses see.
 */
const layerAdapterServices = (home: string, environment: NodeJS.ProcessEnv) =>
  Layer.mergeAll(
    layerClaudeQueryRunner,
    layerCodexClientFactory,
    IdAllocator.layer,
    ServerConfig.layerTest(home, home),
    Layer.succeed(HostProcessEnvironment, environment),
  ).pipe(
    Layer.provideMerge(
      Layer.succeed(
        ProviderEventLoggers.ProviderEventLoggers,
        ProviderEventLoggers.NoOpProviderEventLoggers,
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

/**
 * One machine's adapters, each under the instance id a self-hosted server
 * gives it by default, with its state under `root`. The adapters and their
 * sessions live as long as the scope.
 */
export const makeRunnerAdapters = Effect.fn("makeRunnerAdapters")(function* (machine: {
  readonly root: string;
  readonly gatewayUrl: string;
}) {
  const layout = machineLayout(yield* Path.Path, machine.root);
  yield* prepareMachine(layout, machine.gatewayUrl);
  const services = yield* Layer.build(
    layerAdapterServices(
      machine.root,
      harnessEnvironment(yield* HostProcessEnvironment, layout, machine.gatewayUrl),
    ),
  );
  const common = { displayName: undefined, environment: [], enabled: true } as const;
  const claude = yield* ClaudeAdapterV2Driver.create({
    ...common,
    instanceId: defaultInstanceIdForDriver(ClaudeAdapterV2Driver.driverKind),
    config: claudeSettings(ClaudeAdapterV2Driver.defaultConfig(), layout),
  }).pipe(Effect.provide(services));
  const codex = yield* CodexAdapterV2Driver.create({
    ...common,
    instanceId: defaultInstanceIdForDriver(CodexAdapterV2Driver.driverKind),
    config: codexSettings(CodexAdapterV2Driver.defaultConfig(), layout),
  }).pipe(Effect.provide(services));
  return {
    layout,
    adapters: new Map<ProviderInstanceId, ProviderAdapterV2Shape>([
      [claude.instanceId, claude],
      [codex.instanceId, codex],
    ]) as ReadonlyMap<ProviderInstanceId, ProviderAdapterV2Shape>,
  };
});
