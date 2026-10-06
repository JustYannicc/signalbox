import * as Effect from "effect/Effect";

import { listPoolOverviews } from "../../../accountHub/poolOverview.ts";
import { readCaller, unavailable } from "../../threadAccess.ts";
import { PoolsToolkit } from "./tools.ts";

export const layer = PoolsToolkit.toLayer({
  t3_pool_list: () =>
    Effect.gen(function* () {
      yield* readCaller();
      return { pools: yield* listPoolOverviews.pipe(Effect.mapError(unavailable)) };
    }),
});
