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

### Machines on boat

With `MACHINE_BACKEND=boat`, each thread runs on its own [boat](https://docs.boat.dev)
VM (`small`: 2 vCPU / 4 GB), started when a turn needs it and stopped after a
10-minute idle tail. The VM's disk survives the stop, so the next message
resumes the same VM with its checkout and caches. The Worker needs:

| Name                | Kind   | What                                                                 |
| ------------------- | ------ | -------------------------------------------------------------------- |
| `MACHINE_BACKEND`   | var    | `boat`                                                               |
| `BOAT_API_KEY`      | secret | A boat API key                                                       |
| `CLOUD_URL`         | var    | The cloud's public origin, which machines dial. The deploy sets it.  |
| `MODEL_GATEWAY_URL` | var    | The ModelGateway's public origin                                     |
| `RUNNER_IMAGE`      | var    | Optional. Defaults to `ghcr.io/justyannicc/signalbox-runner:nightly` |
| `BOAT_MACHINE_TYPE` | var    | Optional. `small` (default), `default` or `large`                    |
| `BOAT_TTL_SECONDS`  | var    | Optional. Hard TTL, default 7200 (2 hours, boat's trial maximum)     |

The deploy workflow passes `BOAT_API_KEY` from the GitHub environment's
secrets and `MACHINE_BACKEND` and `MODEL_GATEWAY_URL` from its variables, so
setting those three turns boat on for production or previews.

How a machine comes up, in `apps/cloud/src/thread/runner/boat/`: the thread
object records the machine it wants before every boat call, creates the VM with
an idempotency key it keeps until boat names the VM, and resumes a stopped one.
Its alarm retries until the machine is up or stopped, so a duplicate alarm or a
lost boat response never makes a second VM. The VM is created `noEnv` with a
setup script that installs the Runner as a systemd unit; the object then writes
the Runner's config (generation, token, cloud and gateway URLs, image) to
`/home/user/signalbox/machine.json`, and the Runner dials in. boat stops every
VM at its TTL whatever the object does, so a thread object that is gone cannot
leak one. While a turn runs, the object pushes that deadline out every quarter
TTL, so only an abandoned VM reaches it.

The boat key needs the actions `sandbox.create`, `sandbox.read`,
`sandbox.update`, `sandbox.stop`, `sandbox.resume`, `sandbox.delete` and
`file.write`.

To try it locally, the machine must reach your `wrangler dev` and the gateway,
for example through `cloudflared tunnel --url http://127.0.0.1:8787
--http-host-header 127.0.0.1:8787` (the host header keeps `LOCAL_WORKERD`
happy), with `CLOUD_URL` and `MODEL_GATEWAY_URL` set to the tunnels.

### The Runner image

`.github/workflows/runner-image.yml` builds the image every VM runs: Node, git,
the bundled Runner (`vp run runner:bundle` in `apps/server`), and the `claude`
and `codex` versions pinned in
`apps/server/src/signalbox/runner/image/Dockerfile`. It publishes
`ghcr.io/justyannicc/signalbox-runner` as `nightly` (and
`nightly-<date>-<sha>`) every night from `main`, and as `X.Y.Z` and `stable`
for every `vX.Y.Z` tag. Run it by hand to publish one now. Pull requests that
change the Runner build the image without publishing it.

Machines pull the image anonymously, so the package must be public: after its
first publish, set its visibility once under the package's settings on GitHub.
A machine follows `RUNNER_IMAGE` at its next wake. Bump the Runner protocol
only together with a published image, since a machine on an older image is
refused.

### Drives

Each person has one drive per context (their My Drive), and every thread they
start in that context works in it (`apps/cloud/src/drive/`). A drive is a git
repository with no git server: packs in the `DRIVE_PACKS` R2 bucket
(`signalbox-drives`, previews `signalbox-drives-preview`, both in the EU
jurisdiction), refs in the drive's `DriveObject`. The Runner checks the
thread's branch out as the harness's working directory, uploads one pack and
moves `wip/<thread>` after each batch of tool calls, and at the end of a turn
merges `main` into `threads/<thread>` and fast-forwards `main`. A merge
conflict goes back to the agent as one more step of the same turn. Clients
browse `main` and each turn's diff through the Worker, with no machine
running.

Two invariants hold the store together, both enforced in the Worker and the
drive object rather than trusted to the Runner:

- **Objects before refs.** An upload is checked object by object, stored in
  R2, and only then indexed; a pack is refused unless everything its commits
  and trees reference is in it or already indexed. A ref can only name an
  indexed commit, so a machine killed mid-upload leaves at most an orphaned
  file in R2.
- **Whose refs.** The drive token (`drive/driveToken.ts`) names one thread and
  machine generation. That thread moves only `threads/<thread>` and
  `wip/<thread>`, and `main` only as a fast-forward to its own branch while its
  turn runs. An older generation writes nothing once a newer one has.

`wrangler dev` keeps the bucket locally. Deployments need both buckets
created once (`wrangler r2 bucket create signalbox-drives --jurisdiction eu`,
and the same for `-preview`); without them the deploy fails.

### Dependency and build caches

A machine's caches live on its disk next to the checkouts, never in a drive.
Package-manager stores and download caches (pnpm's store, npm's cache,
Corepack, `XDG_CACHE_HOME`) are under `caches/<toolchain>` in the machine's
home (`apps/server/src/signalbox/runner/RunnerCaches.ts`), one directory per
OS, libc, architecture and Node major, and the harnesses see them through the
environment. Before each turn, after the checkout is synced, the Runner finds
every pnpm or npm lockfile up to two folders deep and keys it on the lockfile,
the package manager's other install inputs and the toolchain
(`RunnerDependencies.ts`). An unchanged key reuses `node_modules` and the
build caches tools keep in it. A changed key, or an install that never
finished, discards every `node_modules` under that folder and installs fresh
from the warm store, so nothing built against the old dependencies survives.
An install that failed is not retried until its key changes. A drive never
saves `node_modules`, whatever the repository's own ignore files say. The
image enables Corepack, so a project's `packageManager` picks the pnpm or
yarn the agent's shell runs.

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
