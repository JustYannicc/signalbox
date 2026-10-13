# Accounts setup

Accounts use WorkOS AuthKit. How they work and why is in
[Accounts](../internals/accounts.md).

## Server configuration

| Variable                     | Required | Notes                                                                     |
| ---------------------------- | -------- | ------------------------------------------------------------------------- |
| `T3CODE_WORKOS_CLIENT_ID`    | yes      | Public. Without it, accounts are off and clients pair.                    |
| `T3CODE_WORKOS_API_KEY`      | yes\*    | Secret. Needed to finish email verification, e.g. after a GitHub sign-in. |
| `T3CODE_WORKOS_API_BASE_URL` | no       | Defaults to `https://api.workos.com`.                                     |
| `T3CODE_WORKOS_PROVIDERS`    | no       | Comma list of `google,github,apple,email` to offer. Defaults to all four. |

\*Sign-in itself uses PKCE and works without the key, but WorkOS asks for an
email code whenever it does not trust a provider's email (GitHub, for example),
and redeeming that code requires the secret. Without it those sign-ins fail.

Any WorkOS account that signs in gets a session, so enable accounts only where
that is intended (hosted Signalbox). Self-hosted servers leave them off and pair.

For development, put these in the main checkout's `.env`. `scripts/dev-runner.ts`
loads it, and the `t3.json` setup links it into worktrees. Mobile reads an
optional default server address from `EXPO_PUBLIC_SIGNALBOX_SERVER_URL`.

## WorkOS application

Register `<server origin>/api/account/callback` as a redirect URI for every
origin clients use to reach the server. WorkOS rejects a wildcard as the
default URI, so keep one exact URI as the default. The Signalbox staging
environment registers `http://localhost:*`, `http://127.0.0.1:*` and
`https://*.ts.net` for dev and tailnet servers. Wildcards are a staging
convenience. Production should list only the hosted origins.

Enable these sign-in methods to match the clients: Google, GitHub, Apple, email
and password, and email code (Magic Auth). The hosted page also offers any
other method you enable, and desktop uses that page. Staging uses WorkOS's
default OAuth credentials. Production needs your own Google, GitHub and Apple
credentials.

Branding for the hosted page, the sign-in methods, and the redirect URIs can be
changed with the WorkOS API or the dashboard. Logos need a dashboard upload.
