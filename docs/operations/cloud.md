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

`.github/workflows/deploy-cloud.yml` deploys on every push to `main` that
touches the cloud or what it serves, and on a manual run from `main`. It builds
the web app, then runs `wrangler deploy` with the Worker's secrets attached to
the new version.

Everything it needs lives in the `cloud-production` GitHub environment, which
only `main` can use:

| Name                      | Kind     | What                                                                    |
| ------------------------- | -------- | ----------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`    | secret   | Account › Workers Scripts: Edit and Account › Account Settings: Read    |
| `CLOUDFLARE_ACCOUNT_ID`   | variable | The Cloudflare account                                                  |
| `CLOUD_SESSION_SECRET`    | secret   | Signs sessions and seals sign-in state. Rotating it signs everyone out. |
| `T3CODE_WORKOS_CLIENT_ID` | variable | WorkOS client id                                                        |
| `T3CODE_WORKOS_API_KEY`   | secret   | WorkOS API key, needed to finish email verification (GitHub sign-ins)   |
| `CLOUD_URL`               | variable | The deployed origin, shown on deployments                               |

A custom domain additionally needs Zone › Workers Routes: Edit on that zone,
and the domain's `/api/account/callback` registered as a WorkOS redirect URI.

`ENVIRONMENT_ID` in `wrangler.jsonc` is the cloud's identity. Clients key saved
connections on it, so never change it for a live deployment.
