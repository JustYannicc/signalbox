import type {
  ModelSelection,
  ProviderInstanceConfig,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { PoolEntry } from "../pool/poolViews.ts";
import * as ModelManifest from "./ModelManifest.ts";
import {
  poolDefaultModelSelection,
  poolProviderInstances,
  poolProviders,
} from "./internal/catalog/poolProviders.ts";
import { initialSelection } from "./internal/catalog/initialSelection.ts";

export { cloudProviders, cloudProviderInstances } from "./internal/catalog/providerCatalog.ts";

export interface ModelCatalogView {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly instances: Record<ProviderInstanceId, ProviderInstanceConfig>;
  readonly defaultModelSelection: ModelSelection | null;
}

interface CatalogInput {
  readonly pools: ReadonlyArray<PoolEntry>;
  readonly checkedAt: string;
}

export class ModelCatalog extends Context.Service<
  ModelCatalog,
  {
    readonly view: (input: CatalogInput) => Effect.Effect<ModelCatalogView>;
    readonly initialSelection: (
      input: CatalogInput & {
        readonly poolId: string | null;
        readonly personDefault: ModelSelection | null;
      },
    ) => Effect.Effect<ModelSelection | null>;
  }
>()("@signalbox/cloud/models/ModelCatalog") {}

const make = Effect.gen(function* () {
  const manifest = yield* ModelManifest.ModelManifest;
  const view: ModelCatalog["Service"]["view"] = ({ pools, checkedAt }) =>
    Effect.map(manifest.current, (catalogs) => {
      const providers = poolProviders(pools, checkedAt, catalogs);
      return {
        providers,
        instances: poolProviderInstances(pools.map((entry) => entry.pool)),
        defaultModelSelection: poolDefaultModelSelection(providers),
      };
    });
  return ModelCatalog.of({
    view,
    initialSelection: (input) =>
      Effect.map(view(input), ({ providers }) =>
        initialSelection(providers, input.poolId, input.personDefault),
      ),
  });
});

export const layer = Layer.effect(ModelCatalog, make);
