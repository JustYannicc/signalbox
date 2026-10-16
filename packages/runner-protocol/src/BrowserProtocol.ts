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
 *
 * `signIn` is the agent's `sign_in` tool (#576): the cloud signs the person's
 * profile in to a site from 1Password and answers only a status, never a
 * value. It ends the thread's session before logging in, so that session
 * can't save the profile over the login, and the machine's next session
 * loads the profile with the login in it.
 */

export const BROWSER_PATHS = {
  session: `${DRIVE_API_PREFIX}/browser/session`,
  end: `${DRIVE_API_PREFIX}/browser/end`,
  signIn: `${DRIVE_API_PREFIX}/browser/sign-in`,
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

/** A page or site address; the cloud keeps its origin. */
export const BrowserSignInRequest = Schema.Struct({
  site: Schema.String.check(Schema.isMaxLength(2048)),
});
export type BrowserSignInRequest = typeof BrowserSignInRequest.Type;

/**
 * How a sign-in went, in words for the agent. `site` is the site as grants
 * name it. Only `signed_in` names the 1Password login, by title and username.
 */
export const BrowserSignInAnswer = Schema.Union([
  Schema.TaggedStruct("signed_in", {
    site: Schema.String,
    item: Schema.String,
    username: Schema.NullOr(Schema.String),
  }),
  Schema.TaggedStruct("no_saved_login", { site: Schema.String, message: Schema.String }),
  /** The grant or the requester check said no; `message` tells the agent what to ask the person. */
  Schema.TaggedStruct("not_allowed", { site: Schema.String, message: Schema.String }),
  /** The login couldn't finish without the person; `message` says why. */
  Schema.TaggedStruct("failed", { site: Schema.String, message: Schema.String }),
]);
export type BrowserSignInAnswer = typeof BrowserSignInAnswer.Type;

export const browserJson = {
  session: jsonCodec(BrowserSessionAnswer),
  endRequest: jsonCodec(BrowserEndRequest),
  signInRequest: jsonCodec(BrowserSignInRequest),
  signIn: jsonCodec(BrowserSignInAnswer),
};
