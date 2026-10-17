import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { ModelManifest } from "../thread/ModelManifest.ts";
import type { PoolsState } from "../user/UserPools.ts";
import { poolProviders } from "./poolViews.ts";

/** One catalog query for server.config, the picker and thread capabilities. Pools own availability. */
export const poolModelCatalog = (state: PoolsState) =>
  Effect.gen(function* () {
    const manifest = yield* ModelManifest;
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    return { checkedAt, providers: poolProviders(state, checkedAt, yield* manifest.current) };
  });
