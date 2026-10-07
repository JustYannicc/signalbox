import * as Effect from "effect/Effect";

import { listPoolOverviews } from "../../../accountHub/poolOverview.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, unavailable } from "../../threadAccess.ts";
import { PoolsToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(PoolsToolkit, {
  t3_pool_list: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      yield* readCaller();
      return { pools: yield* listPoolOverviews.pipe(Effect.mapError(unavailable)) };
    }),
  ),
});
