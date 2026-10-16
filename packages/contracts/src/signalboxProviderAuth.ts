/**
 * A provider sign-in that runs in a browser the server holds (#205). Claude's
 * and ChatGPT's logins only redirect to `localhost`, which no client reaches
 * when the account goes into a cloud pool. Signalbox Cloud opens the login in
 * a cloud browser, catches the redirect there and hands it to the pool, so
 * the person only signs in. `url` is that browser's live view: clients embed
 * it, and it carries its own credential, so it is never logged.
 *
 * Part of `ProviderAuthInteraction`; older clients drop it and see a sign-in
 * waiting without one.
 */
import * as Schema from "effect/Schema";

import { PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ProviderAuthLiveView = Schema.Struct({
  type: Schema.Literal("liveView"),
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  url: TrimmedNonEmptyString.check(Schema.isMaxLength(16_384)),
  /** The provider's sign-in site, such as `claude.ai`, for the person to see where they are. */
  site: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  /**
   * The browser's page size in CSS pixels. The live view crops rather than
   * scales, so clients render it at this size and scale it to fit.
   */
  viewport: Schema.Struct({ width: PositiveInt, height: PositiveInt }),
});
export type ProviderAuthLiveView = typeof ProviderAuthLiveView.Type;
