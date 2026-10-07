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

### Real Claude and Codex turns

Claude and Codex turns run in a Runner on a machine, never in the Worker, and
the machine holds no provider keys: its `claude` and `codex` reach their models
through the ModelGateway, a second Worker that holds the keys. Locally you run
both. Put the keys in `apps/cloud/.dev.vars.model-gateway` (gitignored):

```sh
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...
# Optional: an Anthropic- or OpenAI-compatible endpoint instead of the provider's own API.
# ANTHROPIC_UPSTREAM_URL=https://...
# OPENAI_UPSTREAM_URL=https://...
```

and start the gateway next to `vp run dev`:

```sh
cd apps/cloud && vp run dev:gateway             # ModelGateway on http://127.0.0.1:8788
node apps/server/src/signalbox/runner/main.ts   # Runner host on http://127.0.0.1:8790
```

Then add `LOCAL_RUNNER_URL=http://127.0.0.1:8790` and
`MODEL_GATEWAY_URL=http://127.0.0.1:8788` to `apps/cloud/.dev.vars`. The cloud
offers Claude and Codex only when both are set. Each thread gets its own Runner
and its own machine directory under `apps/server/.t3/runner/machines/` (`--home`
moves it), with a home, Claude and Codex config, and the current turn's model
token, so the harnesses never see this machine's own logins or keys.
`LOCAL_RUNNER_URL` only counts with `LOCAL_WORKERD`, so a deployment never calls
it.

A model token is good for one thread, one provider and one turn: the gateway
asks the thread before each request, and the thread grants it only while that
turn runs. The gateway logs every request as `model_gateway.request`, with
`authMs` (its own time before forwarding) and `firstChunkMs` (the upstream's
time to first token). If the upstream uses a private CA, start the gateway with
`NODE_EXTRA_CA_CERTS` pointing at it.

`POST http://127.0.0.1:8790/machines/drop-sockets` cuts every Runner's socket,
to watch one reconnect mid-turn and resend what the thread has not acknowledged.

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
| `T3CODE_WORKOS_API_KEY`    | secret   | WorkOS API key: email verification (GitHub sign-ins) and work contexts  |
| `VITE_T3CODE_FEEDBACK_DSN` | variable | Sentry DSN for the sidebar feedback button, baked into the web build    |

WorkOS must list each origin's `/api/account/callback` as a redirect URI:
`https://app.signalbox.run/...` for production and
`https://*.signalbox.run/...` for previews.

`ENVIRONMENT_ID` in `wrangler.jsonc` is the cloud's identity. Clients key saved
connections on it, so never change it for a live deployment.
