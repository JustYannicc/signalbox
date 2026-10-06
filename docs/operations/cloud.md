# Signalbox Cloud

Signalbox Cloud (`apps/cloud`) is an environment that runs on Cloudflare: a
Worker that speaks the same environment protocol and session auth as a
self-hosted server, and one User Durable Object per WorkOS user, always in the
EU jurisdiction. It serves the web app from its own origin. The design is in
issue #110.

## Local development

```sh
cd apps/cloud
cp .dev.vars.example .dev.vars   # fill in; gitignored
vp run dev                       # wrangler dev on http://localhost:8787
```

`wrangler dev` runs fully local: its Durable Object state lives in
`apps/cloud/.wrangler/` and nothing reaches Cloudflare. Local workerd has no
jurisdictions, so `vp run dev` sets `LOCAL_WORKERD=1` to use the plain
namespace; the Worker refuses to serve with that flag on any host other than
localhost. Use the WorkOS staging client, whose redirect URIs include
`http://localhost:*`.

To use the real web UI against it, build the web app once
(`vp run --filter @t3tools/web build`) and open `http://localhost:8787`, or run
web dev with `T3CODE_PORT=8787` so the Vite proxy forwards to the Worker.

## Deploying

`.github/workflows/deploy-cloud.yml` builds the web app and runs `wrangler
deploy` with the Worker's secrets attached to the new version:

- **Production:** every push to `main` that touches the cloud or what it serves,
  and manual runs from `main`, deploy `app.signalbox.run`.
- **Previews:** same-repository pull requests opened by `JustYannicc` deploy
  `preview-<number>.signalbox.run`. Each preview is its own Worker
  (`signalbox-cloud-pr-<number>`, the `preview` environment in
  `wrangler.jsonc`) with its own Durable Objects, so it never shares users or
  sessions with production. Closing the pull request deletes it.

Both read from a GitHub environment. `cloud-production` is limited to `main`;
`cloud-preview` holds the same names, with `CLOUD_PREVIEW_SESSION_SECRET`, from
which each preview derives its own session secret.

| Name                       | Kind     | What                                                                    |
| -------------------------- | -------- | ----------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`     | secret   | Account › Workers Scripts: Edit and Account › Account Settings: Read    |
| `CLOUDFLARE_ACCOUNT_ID`    | variable | The Cloudflare account                                                  |
| `CLOUD_SESSION_SECRET`     | secret   | Signs sessions and seals sign-in state. Rotating it signs everyone out. |
| `T3CODE_WORKOS_CLIENT_ID`  | variable | WorkOS client id                                                        |
| `T3CODE_WORKOS_API_KEY`    | secret   | WorkOS API key, needed to finish email verification (GitHub sign-ins)   |
| `VITE_T3CODE_FEEDBACK_DSN` | variable | Sentry DSN for the sidebar feedback button, baked into the web build    |

WorkOS must list each origin's `/api/account/callback` as a redirect URI:
`https://app.signalbox.run/...` for production and
`https://*.signalbox.run/...` for previews.

`ENVIRONMENT_ID` in `wrangler.jsonc` is the cloud's identity. Clients key saved
connections on it, so never change it for a live deployment.
