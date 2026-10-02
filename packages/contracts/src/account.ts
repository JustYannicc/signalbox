import * as Schema from "effect/Schema";

/**
 * Signalbox accounts: WorkOS-backed sign-in that ends in a normal environment
 * session. Fork-owned; upstream T3 Code has no equivalent.
 *
 * Every route lives under `/api/account` on the environment server, so the dev
 * proxy and tunnels already carry it. The server talks to WorkOS; clients only
 * navigate to `authorize` and read `session`.
 *
 * Flow:
 * 1. Client navigates (browser) or opens a system browser (native) to
 *    `GET /api/account/authorize`.
 * 2. WorkOS redirects to `GET /api/account/callback` on the same origin.
 * 3. Browser mode: the callback sets the session cookie and redirects to
 *    `returnTo`. Native mode: it redirects to `returnUrl?handoff=<id>`, and the
 *    client redeems `POST /api/account/handoff` with its PKCE verifier to get a
 *    one-time pairing credential it exchanges the usual way.
 */

export const ACCOUNT_API_PREFIX = "/api/account";
export const ACCOUNT_SESSION_PATH = `${ACCOUNT_API_PREFIX}/session`;
export const ACCOUNT_AUTHORIZE_PATH = `${ACCOUNT_API_PREFIX}/authorize`;
export const ACCOUNT_CALLBACK_PATH = `${ACCOUNT_API_PREFIX}/callback`;
export const ACCOUNT_HANDOFF_PATH = `${ACCOUNT_API_PREFIX}/handoff`;
export const ACCOUNT_SIGN_OUT_PATH = `${ACCOUNT_API_PREFIX}/sign-out`;
export const ACCOUNT_VERIFY_EMAIL_PATH = `${ACCOUNT_API_PREFIX}/verify-email`;

/**
 * Web route that renders the sign-in screen. Callback errors redirect here.
 *
 * Desktop signs in in the system browser (password managers, saved sessions,
 * passkeys) by opening `authorize` with `provider: "email"`, `mode: "native"`,
 * `via: "web"` and a `screenHint`. The callback lands here with `?handoff=` and
 * `?returnUrl=`; the page confirms and opens `returnUrl?handoff=…` (errors are
 * forwarded the same way so the app can show them).
 *
 * Email verification: WorkOS trusts some providers' emails (Google) but not
 * others (GitHub), and then emails the user a code before finishing sign-in.
 * The callback redirects to `/sign-in?verify=<id>&email=<address>` on `origin`
 * in every mode (the page also loads inside mobile's auth sheet and desktop's
 * browser), and the page posts the code to `ACCOUNT_VERIFY_EMAIL_PATH`.
 */
export const ACCOUNT_SIGN_IN_ROUTE = "/sign-in";

/**
 * Sign-in options in display order. `email` opens WorkOS's hosted page, which
 * handles password and email-code sign-in plus sign-up for that address.
 * Adding a WorkOS social provider is one entry here and one in the server's
 * provider map.
 */
export const AccountProvider = Schema.Literals(["google", "github", "apple", "email"]);
export type AccountProvider = typeof AccountProvider.Type;

export const AccountProfile = Schema.Struct({
  /** WorkOS user id (`user_…`). */
  id: Schema.String,
  email: Schema.String,
  firstName: Schema.optional(Schema.String),
  lastName: Schema.optional(Schema.String),
  avatarUrl: Schema.optional(Schema.String),
});
export type AccountProfile = typeof AccountProfile.Type;

/**
 * `GET /api/account/session`. Public; never 401s.
 *
 * - `enabled: false`: the server has no WorkOS client configured. Clients fall
 *   back to pairing exactly as before.
 * - `enabled: true, account: null`: show the sign-in screen. Any existing
 *   environment session (pairing, desktop bootstrap) is not an account.
 *
 * Any WorkOS account that signs in gets a session; there is no owner or
 * allowlist. Hosted Signalbox runs the work behind the account.
 */
export const AccountSessionState = Schema.Struct({
  enabled: Schema.Boolean,
  providers: Schema.Array(AccountProvider),
  account: Schema.NullOr(AccountProfile),
});
export type AccountSessionState = typeof AccountSessionState.Type;

/**
 * Query parameters for `GET /api/account/authorize`.
 *
 * `origin` is the server origin as the client reaches it (`window.location.origin`
 * on web, the environment base URL on native). The dev proxy rewrites `Host`,
 * so the server cannot derive it. WorkOS only accepts registered redirect URIs,
 * which bounds what an attacker-chosen origin can do.
 */
export const AccountAuthorizeMode = Schema.Literals(["browser", "native"]);
export type AccountAuthorizeMode = typeof AccountAuthorizeMode.Type;

export const AccountAuthorizeParams = Schema.Struct({
  provider: AccountProvider,
  origin: Schema.String,
  mode: AccountAuthorizeMode,
  /** Prefills the email on WorkOS's page. Only meaningful for `email`. */
  loginHint: Schema.optional(Schema.String),
  /** Ask the provider to show its account picker (after sign-out or "use another account"). */
  selectAccount: Schema.optional(Schema.Literals(["1"])),
  /** Browser mode: same-origin path to land on afterwards. Defaults to `/`. */
  returnTo: Schema.optional(Schema.String),
  /** Native mode: deep link to return to. Must use a Signalbox app scheme. */
  returnUrl: Schema.optional(Schema.String),
  /** Native mode: base64url(SHA-256(verifier)). Binds the handoff to this client. */
  challenge: Schema.optional(Schema.String),
  /**
   * Native mode where the user signs in in their system browser (desktop).
   * The callback lands on `/sign-in?handoff=…&returnUrl=…` (or
   * `?error=…&returnUrl=…`) on `origin` instead of jumping straight to
   * `returnUrl`, so a page can confirm sign-in and open the app itself.
   */
  via: Schema.optional(Schema.Literals(["web"])),
  /**
   * `email` only: which tab WorkOS's hosted page opens on. If the browser
   * already has a WorkOS session, it skips the page and returns immediately.
   */
  screenHint: Schema.optional(Schema.Literals(["sign-in", "sign-up"])),
});
export type AccountAuthorizeParams = typeof AccountAuthorizeParams.Type;

/** Deep-link schemes the server will hand off to in native mode. */
export const ACCOUNT_NATIVE_RETURN_SCHEMES = [
  "signalbox:",
  "signalbox-dev:",
  "signalbox-preview:",
] as const;

/**
 * Error codes the callback reports as `?error=` on `/sign-in` (browser) or on
 * the native return URL.
 * - `cancelled`: the user backed out at the provider.
 * - `expired`: the sign-in attempt timed out or the server restarted mid-flow.
 * - `failed`: anything else; details are in server logs.
 */
export const AccountSignInError = Schema.Literals(["cancelled", "expired", "failed"]);
export type AccountSignInError = typeof AccountSignInError.Type;

/**
 * `POST /api/account/handoff`. Single use; expires with the sign-in attempt.
 * Failures respond with a 4xx and `AccountHandoffFailure`; an unknown handoff
 * is `expired`.
 */
export const AccountHandoffRequest = Schema.Struct({
  handoff: Schema.String,
  verifier: Schema.String,
});
export type AccountHandoffRequest = typeof AccountHandoffRequest.Type;

/** A one-time pairing credential bound to the account, redeemed like any pairing token. */
export const AccountHandoffResult = Schema.Struct({
  credential: Schema.String,
  account: AccountProfile,
});
export type AccountHandoffResult = typeof AccountHandoffResult.Type;

export const AccountHandoffFailure = Schema.Struct({ error: AccountSignInError });
export type AccountHandoffFailure = typeof AccountHandoffFailure.Type;

/** `POST /api/account/verify-email`. Single attempt id, retryable on a wrong code. */
export const AccountVerifyEmailRequest = Schema.Struct({
  verify: Schema.String,
  code: Schema.String,
});
export type AccountVerifyEmailRequest = typeof AccountVerifyEmailRequest.Type;

/**
 * Where the page goes next, exactly what the callback would have redirected
 * to: `returnTo` (browser mode, cookie already set), `returnUrl?handoff=…`
 * (native), or `/sign-in?handoff=…&returnUrl=…` (native via web).
 */
export const AccountVerifyEmailResult = Schema.Struct({ next: Schema.String });
export type AccountVerifyEmailResult = typeof AccountVerifyEmailResult.Type;

/**
 * 4xx body. `invalid-code`: wrong or mistyped code, the attempt stays open.
 * `expired`: the attempt or WorkOS's pending sign-in is gone; start over.
 */
export const AccountVerifyEmailFailure = Schema.Struct({
  error: Schema.Literals(["invalid-code", "expired", "failed"]),
});
export type AccountVerifyEmailFailure = typeof AccountVerifyEmailFailure.Type;
