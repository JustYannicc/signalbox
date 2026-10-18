import * as Effect from "effect/Effect";

import * as ModelAuthority from "./internal/ModelAuthority.ts";
import * as ModelAccess from "./ModelAccess.ts";

export const makeModelAccess = (authority: ModelAuthority.ModelAuthority["Service"]) =>
  ModelAccess.ModelAccess.pipe(
    Effect.provide(ModelAccess.layer),
    Effect.provideService(ModelAuthority.ModelAuthority, authority),
  );

export { makeUsageScanner } from "./internal/gateway/usageScanner.ts";
