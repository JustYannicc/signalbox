import * as NodeServices from "@effect/platform-node/NodeServices";
import { type ProviderInstanceId, defaultInstanceIdForDriver } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

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
import type { AnyProviderAdapterDriver } from "../../orchestration-v2/ProviderAdapterDriver.ts";

/**
 * The provider adapters a Runner drives, built by upstream's own adapter
 * drivers (`ClaudeAdapterV2Driver`, `CodexAdapterV2Driver`) with each one's
 * default settings: the stock CLI on PATH, signed in the way it already is on
 * this machine. Only the services those constructors ask for are provided,
 * not the server's layer graph, so the Runner carries no settings store, MCP
 * server or session database, and an upstream change to an adapter reaches
 * the Runner through a normal merge.
 */

/**
 * What the adapter constructors need. The server config only supplies paths
 * under `home`; the adapters read nothing else from it.
 */
const layerAdapterServices = (home: string) =>
  Layer.mergeAll(
    layerClaudeQueryRunner,
    layerCodexClientFactory,
    IdAllocator.layer,
    ServerConfig.layerTest(home, home),
  ).pipe(
    Layer.provideMerge(
      Layer.succeed(
        ProviderEventLoggers.ProviderEventLoggers,
        ProviderEventLoggers.NoOpProviderEventLoggers,
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

const DRIVERS: ReadonlyArray<
  AnyProviderAdapterDriver<Layer.Success<ReturnType<typeof layerAdapterServices>>>
> = [ClaudeAdapterV2Driver, CodexAdapterV2Driver];

/**
 * Each adapter under the instance id a self-hosted server gives it by
 * default. The adapters and their sessions live as long as the scope.
 */
export const makeRunnerAdapters = Effect.fn("makeRunnerAdapters")(function* (home: string) {
  const services = yield* Layer.build(layerAdapterServices(home));
  const adapters = new Map<ProviderInstanceId, ProviderAdapterV2Shape>();
  for (const driver of DRIVERS) {
    const adapter = yield* driver
      .create({
        instanceId: defaultInstanceIdForDriver(driver.driverKind),
        displayName: undefined,
        environment: [],
        enabled: true,
        config: driver.defaultConfig(),
      })
      .pipe(Effect.provide(services));
    adapters.set(adapter.instanceId, adapter);
  }
  return adapters as ReadonlyMap<ProviderInstanceId, ProviderAdapterV2Shape>;
});
