import * as Schema from "effect/Schema";

import { DRIVE_API_PREFIX } from "./DriveProtocol.ts";
import { jsonCodec } from "./jsonCodec.ts";

/**
 * How a thread's machine gets the person's browser (#574): a Kernel browser
 * built from their persistent profile, for the real sites the `preview_*`
 * tools open. The machine asks with the thread's drive token
 * (`DriveProtocol.ts`), only while a turn runs, and the cloud opens the
 * session as the thread's owner. The Kernel key stays in the cloud; the
 * machine only ever holds the session's CDP endpoint. The browser runs
 * headless, so Kernel has no live view or replays for it; the machine mirrors
 * its pages to the owner's clients instead (`PreviewTunnel.ts`, #587).
 *
 * `session` returns the thread's open session, or opens one. `end` deletes
 * it, which is what saves the profile; a session nobody ends times out on
 * Kernel's side and saves the same way. Both answer 200 with a refusal in
 * words for the agent, such as the plan's browser limit, rather than failing.
 * A cloud without Kernel answers `unconfigured`, and every site opens in the
 * machine's own browser, as before #574.
 */

export const BROWSER_PATHS = {
  session: `${DRIVE_API_PREFIX}/browser/session`,
  end: `${DRIVE_API_PREFIX}/browser/end`,
} as const;

export const BrowserSessionAnswer = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("ready"),
    sessionId: Schema.String,
    /** Playwright's `connectOverCDP` endpoint; it carries its own credential. */
    cdpWsUrl: Schema.String,
  }),
  Schema.Struct({ _tag: Schema.Literal("refused"), message: Schema.String }),
  /** This cloud has no person's browser (no Kernel key): real sites open on the machine. */
  Schema.Struct({ _tag: Schema.Literal("unconfigured") }),
]);
export type BrowserSessionAnswer = typeof BrowserSessionAnswer.Type;

export const BrowserEndRequest = Schema.Struct({ sessionId: Schema.String });
export type BrowserEndRequest = typeof BrowserEndRequest.Type;

export const browserJson = {
  session: jsonCodec(BrowserSessionAnswer),
  endRequest: jsonCodec(BrowserEndRequest),
};
