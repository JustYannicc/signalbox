# Accounts

Accounts answer "who is this?" before anything else happens. WorkOS AuthKit
proves an identity; the environment then issues an ordinary
[environment session](./environment-auth.md) whose subject is
`account:<workos user id>`. WorkOS tokens are discarded after sign-in, so a
WorkOS outage never interrupts an existing session. The contract and flow live
in [`account.ts`](../../packages/contracts/src/account.ts); the server side is
[`apps/server/src/account`](../../apps/server/src/account).

## Signing in is the only gate

Any WorkOS account that signs in gets a session. There is no owner or allowlist:
hosted Signalbox runs each user's work behind their account, and self-hosters
leave WorkOS unconfigured and pair instead. The server keeps a profile per
account, in a fork-owned, self-creating table (see
[Staying on T3 Code](../../AGENTS.md#staying-on-t3-code)), so clients can show who is
signed in.

The sign-in screen is a client gate. Pairing, the desktop bootstrap and the
reusable dev token still mint sessions. Clients show sign-in whenever
`GET /api/account/session` reports accounts enabled and the current session is
not an account. Without a WorkOS client ID the server reports `enabled: false`
and clients pair exactly as before.

## The client tells the server its origin

`authorize` takes the server origin from the client. The Vite dev proxy rewrites
`Host`, and tunnels and Tailscale put other names in front of the server, so the
server cannot derive its public origin. This is safe only because WorkOS rejects
redirect URIs that are not registered on the WorkOS application. Keep that list
tight. A wildcard there widens which origins can receive a callback.

## Native sign-in binds the handoff to the app

Desktop and mobile cannot receive a cookie from the system browser, and any app
can register a custom URL scheme. So the callback never puts a credential in a
deep link. It returns a handoff id. The app redeems that id together with the
PKCE verifier whose hash it sent to `authorize`. The server mints the one-time
pairing credential only at redemption, so an intercepted link is useless and
abandoned attempts leave nothing in the Connections list.

Native states carry their validated return URL, so an attempt that expired or
outlived a server restart still reports back to the app instead of stranding the
user on a web error page.

## Some providers need an email code

WorkOS trusts Google's emails but not GitHub's, so a first GitHub sign-in stops
with `email_verification_required` after a successful OAuth round trip. The
callback parks the pending token and sends every mode to `/sign-in?verify=…`.
The page posts the emailed code, and the server finishes through the same path
as the callback. The email-verification grant requires the client secret even
though the code grant does not.

## Desktop signs in through the browser

Desktop opens WorkOS's hosted page in the system browser rather than an embedded
window. Google blocks OAuth in embedded webviews, and the system browser has the
user's password manager, passkeys and existing WorkOS session. With that
session, sign-in returns without a prompt. The callback lands on `/sign-in` in
that browser, which confirms and forwards the handoff to the app.

The desktop renderer reaches its server with a bearer from the main process and
sends no cookies, because production CORS does not allow credentialed requests.
It therefore keeps the account's own bearer and sends it only to
`/api/account/*`. Everything else keeps using the desktop bearer.

## Sign-out

Sign-out revokes the current environment session only. The WorkOS browser
session survives, which is what makes the next desktop sign-in instant. After
sign-out, clients pass `selectAccount`. Google then shows its account picker and
the hosted page asks for credentials again, so switching accounts works.
