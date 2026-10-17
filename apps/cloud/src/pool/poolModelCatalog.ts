import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { ModelCatalog } from "../models/ModelCatalog.ts";
import type { PoolEntry } from "./poolViews.ts";

/** One catalog query for server.config, the picker and thread capabilities. Pools own availability. */
export const makePoolModelCatalog = Effect.gen(function* () {
  const catalog = yield* ModelCatalog;
  return (state: ReadonlyArray<PoolEntry>) =>
    Effect.gen(function* () {
      const checkedAt = DateTime.formatIso(yield* DateTime.now);
      const { providers } = yield* catalog.view({ pools: state, checkedAt });
      return { checkedAt, providers };
    });
});

export type PoolModelCatalog = Effect.Success<typeof makePoolModelCatalog>;
