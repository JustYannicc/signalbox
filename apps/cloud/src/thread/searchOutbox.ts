import * as Effect from "effect/Effect";

import * as SearchIndex from "../search/SearchIndex.ts";
import * as ThreadEngine from "./ThreadEngine.ts";

/** Delivers one durable page, acknowledging it only after the index has committed it. */
export const deliverPendingSearch = Effect.gen(function* () {
  const index = yield* SearchIndex.SearchIndex;
  if (index.disabled) return true;
  const engine = yield* ThreadEngine.ThreadEngine;
  const pending = yield* engine.pendingSearchDelivery;
  if (pending === null) return !(yield* engine.hasPendingSearch);
  yield* index.deliver(pending);
  yield* engine.acknowledgeSearchDelivery(pending.revision, pending.deliveryId);
  return !(yield* engine.hasPendingSearch);
});
