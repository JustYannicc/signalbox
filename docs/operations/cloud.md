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
`apps/cloud/.wrangler/` and nothing reaches Cloudflare. It runs the `dev`
environment in `wrangler.jsonc`, the production Worker without its route, so
each request keeps its own host; with a route, `wrangler dev` rewrites every
host to the route's, which would hide preview origins. Local workerd has no
jurisdictions, so `vp run dev` sets `LOCAL_WORKERD=1` to use the plain
namespace; the Worker refuses to serve with that flag on any host other than
localhost. Use the WorkOS staging client, whose redirect URIs include
`http://localhost:*`.

To use the real web UI against it, build the web app once
(`vp run --filter @t3tools/web build`) and open `http://localhost:8787`, or run
web dev with `T3CODE_PORT=8787` so the Vite proxy forwards to the Worker.

### Real Claude and Codex turns

Claude and Codex turns run in a Runner on a machine, never in the Worker, on
the accounts of the thread's pool (see [Account pools](#account-pools)). The
machine holds no key or credential: its `claude` and `codex` call the
ModelGateway, a second Worker, as their provider's API. The gateway holds no
keys either. It checks each request's model token with the thread, which names
the turn's pool, and hands the request to that pool's object over the `GRANTS`
service binding. The pool checks the requester can still use it and sends the
request to its CLIProxyAPI with its own client key. Locally you run both, with
Docker for the pool's container, and start the gateway next to `vp run dev`:

```sh
cd apps/cloud && vp run dev:gateway             # ModelGateway on http://127.0.0.1:8788
node apps/server/src/signalbox/runner/main.ts   # Runner host on http://127.0.0.1:8790
```

Then add `LOCAL_RUNNER_URL=http://127.0.0.1:8790` and
`MODEL_GATEWAY_URL=http://127.0.0.1:8788` to `apps/cloud/.dev.vars`, and sign
an account into a pool (Usage → Limits). Turns on a pool's Claude or ChatGPT
need a machine backend: both set locally, or boat. Each thread gets its own Runner
and its own machine directory under `apps/server/.t3/runner/machines/` (`--home`
moves it), with a home, Claude and Codex config, and the current turn's model
token, so the harnesses never see this machine's own logins or keys.
`LOCAL_RUNNER_URL` only counts with `LOCAL_WORKERD`, so a deployment never calls
it.

A model token is good for one thread, turn, provider, pool and requester: the
gateway asks the thread before each request, and the thread grants it only
while that turn runs. The pool checks the requester on every request, so
someone removed from a pool fails their next request with a message saying
so. The gateway logs every request as `model_gateway.request`, with `authMs`
(the token check), `firstChunkMs` (from forwarding to the first chunk) and
`addedMs`: what the gateway and pool add to the time to first token, which is
everything except the CLIProxyAPI's own time to its response headers (the
token check, the hops, the pool's access check and a cold container's start).
The turn's diagnostics show it on each request's line.

A turn whose folders have secrets (#395) never sends their values to a
provider. The Runner registers the values with the thread before the harness
gets them, and the cloud's side of the gateway replaces every value, in any
common encoding, with `{{secret:NAME}}` as the request body streams to the
pool (`scrubModelRequest.ts`). Until the machine running the turn has
registered, the gateway refuses the turn's requests with "This machine hasn't
registered the folder's secrets to hide them yet."

Production's gateway is `signalbox-model-gateway` at `gateway.signalbox.run`,
deployed after the cloud Worker. Each pull request preview gets its own,
`signalbox-model-gateway-pr-<number>` at
`gateway-preview-<number>.signalbox.run`, bound to the preview's Worker and
deleted with it. Previews set their `MODEL_GATEWAY_URL` themselves.

`POST http://127.0.0.1:8790/machines/drop-sockets` cuts every Runner's socket,
to watch one reconnect mid-turn and resend what the thread has not acknowledged.

### Previews of dev servers

The PreviewGateway (`apps/cloud/src/thread/preview/`) opens the web servers a
thread's machine runs. The Runner keeps a second socket to its thread, the
preview tunnel (`@signalbox/runner-protocol/PreviewTunnel`), reports the web
servers it finds listening (upstream's port discovery, `lsof` in the image),
and carries HTTP and WebSockets to them. The machine accepts no inbound
connections.

Each thread and port gets its own origin, under `PREVIEW_DOMAIN`, because
dev servers expect to own one (absolute paths, HMR sockets, cookies). Clients
ask for a link (`signalbox.previews.open`); the link carries a ticket that the
origin trades for an HttpOnly cookie. Tickets and cookies are signed with the
machine's lease token, so a new generation voids all of them, and every request
is checked against the thread's members. An open preview WebSocket (Vite's
HMR) holds the machine's lease; the idle tail starts when the last one closes
or the last request ends.

Locally, add `PREVIEW_DOMAIN=localhost:8787` to `.dev.vars`: preview origins
are `http://<label>.localhost:8787`, which browsers resolve to loopback. With
the local Runner host, every thread sees the dev servers on your own machine.

Deployments serve previews from `signalbox-preview.dev`, a registrable domain
of its own (the way GitHub serves user content from `githubusercontent.com`):
preview pages are never same-site with `app.signalbox.run` and never get its
cookies. Universal SSL covers one level of subdomains, so every stage's
previews sit side by side in that zone, told apart after the label:
`<label>-app.signalbox-preview.dev` for production and
`<label>-pr<number>.signalbox-preview.dev` for a pull request's preview.
`PREVIEW_DOMAIN` holds that pattern (`*-app.signalbox-preview.dev`; a plain
domain means `*.<domain>`). `apps/cloud/infra/stage.ts` sets it per stage;
`apps/cloud/alchemy.run.ts` keeps one proxied wildcard record for the zone and
gives each stage's Worker a route for its own pattern only, so no route relies on being more specific
than another.

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
| `MODEL_GATEWAY_URL` | var    | The ModelGateway's public origin: `https://gateway.signalbox.run`    |
| `RUNNER_IMAGE`      | var    | Optional. Defaults to `ghcr.io/justyannicc/signalbox-runner:nightly` |
| `BOAT_MACHINE_TYPE` | var    | Optional. `small` (default), `default` or `large`                    |
| `BOAT_TTL_SECONDS`  | var    | Optional. Hard TTL, default 7200 (2 hours, boat's trial maximum)     |

The deploy workflow passes `BOAT_API_KEY` from the GitHub environment's
secrets and `MACHINE_BACKEND` from its variables. Production takes
`MODEL_GATEWAY_URL` from its variables too; a preview points it at its own
gateway. Setting `MACHINE_BACKEND=boat` turns boat on for production or
previews.

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

### Light and heavy machines

A thread runs on one of two machine classes (#113,
`apps/cloud/src/thread/runner/machineClass.ts`). A thread in a drive backed by
a remote repo is heavy; every other thread (a chat, or a task in My Drive) is
light.

- **Light:** a Cloudflare Container bound to the thread's own object
  (`THREADS` in `apps/cloud/alchemy.run.ts`, `basic`: ¼ vCPU, 1 GiB, 4 GB disk),
  started in about a second with a fresh disk and stopped after a 30-second
  idle tail. Its files come from the drive and its session from the thread,
  so the fresh disk loses nothing. The container stops by itself ten minutes
  after its object goes idle, so a thread object that is gone cannot leak one.
  It runs the Runner image built with the Worker: the deploy bundles the
  Runner (`vp run runner:bundle` in `apps/server`) and Alchemy builds
  `apps/server/src/signalbox/runner/image/Dockerfile` from it, so the light
  machine and the Worker always speak the same protocol. A deploy rolls the
  containers, which the thread treats as a lost machine.
- **Heavy:** boat (`MACHINE_BACKEND=boat`, below).

A class without a backend of its own runs on the other one, so a deployment
without boat runs every thread light, and one whose thread objects have no
container (`wrangler dev`, for one) runs every thread on boat or the local
Runner host. The light class needs `CLOUD_URL` and `MODEL_GATEWAY_URL` like
boat does.

A light thread moves to the heavy class for good when its Runner sees a
command it should not run there: a build, test, install or dev server
(`apps/server/src/signalbox/runner/RunnerMachineClass.ts`), or one killed for
memory (exit 137). The Runner saves the turn's files and session rows, reports
`machine.outgrown`, and the thread continues the run on a heavy machine the
same way it continues one whose machine was lost (below): the command shows as
interrupted and the agent runs it again there. A light container that runs out
of memory mid-turn (exit 137) moves its run up too. Any other exit, including
Cloudflare restarting the container for a deploy's rollout, is a lost machine:
the run continues on a new light one.

Each preview gets its own container application,
`signalbox-cloud-pr-<number>-threads`, deleted with the preview. Containers
need the Cloudflare account on the Workers Paid plan.

Every container application has a cap on how many run at once (`maxInstances`
in `apps/cloud/infra/stage.ts`, for pools and threads). Past it no container
starts: pools stop answering and turns fail with "No machine came up".
Cloudflare doesn't alert on it, so `cloud-container-capacity.yml` checks
production every ten minutes and opens an issue at 80%.

To try light machines locally, give the `dev` environment the same
`containers` entry (wrangler builds the image with Docker), bundle the Runner
first, and point `CLOUD_URL` and `MODEL_GATEWAY_URL` at addresses the
container can reach that still arrive at `wrangler dev` as `localhost`.

### The Runner image

`.github/workflows/runner-image.yml` builds the image every VM runs: Node, git,
the bundled Runner (`vp run runner:bundle` in `apps/server`), the `claude`
and `codex` versions pinned in
`apps/server/src/signalbox/runner/image/Dockerfile`, and the headless browser
agents check their own dev servers with (the server's pinned Chrome for
Testing headless shell, plus Playwright). It publishes
`ghcr.io/justyannicc/signalbox-runner` as `nightly` (and
`nightly-<date>-<sha>`) every night from `main`, and as `X.Y.Z` and `stable`
for every `vX.Y.Z` tag. A push to `main` that changes the Runner since the
commit `nightly` was built from also publishes `nightly`, once
`deploy-cloud.yml` has deployed production: the cloud goes first, so a failed
deploy never leaves machines on a Runner the cloud doesn't speak yet. The
publish pulls `nightly` back and checks it runs the pushed commit, and a failed
deploy or build opens a "Production machines don't run main's Runner" issue
that the next publish closes. Run it by hand to publish one now. To see what a
branch would do, dispatch `deploy-cloud.yml` on it with `dry_run`: it decides
against `main` (or the ref in `base`) and builds without deploying or publishing. A pull request that
changes the Runner publishes `pr-<number>` before its preview deploys, and the
preview's `RUNNER_IMAGE` points at it, so boat machines there run the pull
request's Runner. Each push deletes the version it replaces, closing the pull
request deletes the image, and the weekly preview sweep deletes leftovers
(`.github/scripts/runner-pr-images.sh`).

Machines pull the image anonymously, so the package must be public: after its
first publish, set its visibility once under the package's settings on GitHub.
A machine follows `RUNNER_IMAGE` at its next wake. Bump the Runner protocol
only together with a published image, since a machine on an older image is
refused.

### Direct pack uploads

A machine uploads a drive's packs straight to R2 with presigned URLs, and the
cloud reads each back as a stream to check and store it, so no pack meets the
Worker's 100 MB request body or 128 MB of memory (#406). It needs S3
credentials for the packs bucket; without them the cloud answers `inline` and
machines upload in a request's body, up to 64 MiB a pack.

| Name                               | Kind   | What                                                                 |
| ---------------------------------- | ------ | -------------------------------------------------------------------- |
| `DRIVE_PACKS_S3_ACCESS_KEY_ID`     | secret | An R2 API token's access key, Object Read & Write on the bucket      |
| `DRIVE_PACKS_S3_SECRET_ACCESS_KEY` | secret | Its secret                                                           |
| `DRIVE_PACKS_S3_ENDPOINT`          | var    | `https://<account id>.eu.r2.cloudflarestorage.com`                   |
| `DRIVE_PACKS_BUCKET_NAME`          | var    | The bucket `DRIVE_PACKS` binds: `signalbox-drives`, or the preview's |

Uploads wait under `incoming/` until committed. Each bucket needs a lifecycle
rule that deletes `incoming/` objects after a day, for uploads nobody
committed. These come from 1Password through the Alchemy stack (#348, #298).

### Account pools

Each account pool is a `PoolObject` (`apps/cloud/src/pool/`), and a managed
pool runs its own CLIProxyAPI in a Cloudflare Container bound to that object:
the image in `apps/cloud/containers/cliproxyapi/` (CLIProxyAPI's static
release build on distroless, about 24 MB), `lite` instances, started by the
first request and stopped two minutes after the object goes idle. The
container's disk is thrown away every time; CLIProxyAPI keeps its config and
accounts in its object-store backend, which is served from the pool object's
own SQLite through a host only that container can reach. A pool connected to
an admin's own CLIProxyAPI never starts a container.

The model picker offers what each pool's CLIProxyAPI serves (`GET /v1/models`,
which lists only what its enabled accounts can run). Its v8 management catalog
supplies display names and reasoning levels. CLIProxyAPI updates that catalog
itself; new served models do not need a Signalbox deploy. Signalbox keeps a
small fallback for labels, defaults, and established fast-mode support. Account
changes refresh the cache immediately. Alarms refresh pools every three hours,
with a five-minute retry after failures. A managed pool with accounts wakes for
that read and follows the normal idle timeout afterwards.

A turn on a model its pool doesn't serve is refused at turn start
(`thread/TurnModels.ts`). The scripted provider, a reply without a model, is
offered only where `SCRIPTED_PROVIDER=1`: `wrangler dev` and tests, never
production.

#### Connectors in local harnesses

The local harness setup (`apps/cloud/src/localKeys/localSetup.ts`) also adds
an Executor as the MCP server `signalbox` in Codex and Claude Code when the
`EXECUTOR_MCP_URL` variable is set in the GitHub environment (the Executor's
MCP endpoint, e.g. `https://executor.example/mcp`). Unset, setup adds none and
removes one an earlier run added. Each harness signs in to the Executor with its
own MCP sign-in (`/mcp` in Claude Code, `codex mcp login signalbox`), and
`--undo` removes the entry again. Previews use the same variable.

#### CLIProxyAPI updates

The `CLIProxyAPI release sync` workflow checks upstream daily. The shared
manifest at `apps/cloud/containers/cliproxyapi/release.json` holds the version,
the six self-hosted assets and their sizes and SHA-256 checksums, plus the
managed-pool image asset. The Docker build reads it from its build context, and
the account-hub installer imports the same file. The updater verifies every
asset against the release metadata and `checksums.txt`, then edits only this
manifest.

Each release gets one pull request with a link to the release notes. GitHub
auto-merges it after the container smoke test, Cloud preview deploy, and all
current checks pass on the same commit. A failed check, checksum, or missing
asset keeps the release from merging and opens or updates one issue labelled
`cli-proxyapi-update-needs-hand`. The next clean sync or green release PR closes
that issue. The updater uses the existing `UPSTREAM_SYNC_TOKEN`, so GitHub runs
the PR checks and preview as `JustYannicc`.

To roll back a merged update, revert its sync commit and let the normal main
deployment rebuild the prior pins. This restores the previous executable; it
does not roll back config or auth files persisted in a pool or self-hosted
account hub. Treat any release that may have migrated those files as a data
recovery decision as well as an image rollback.

A self-hosted server that moved a pool here keeps a pool link (`pool/poolLink.ts`,
`/api/pool-link`): a token naming the pool's object plus a secret only that
object checks. It acts as the admin who made it, so it stops working when they
lose their grant. It takes accounts for ten minutes after it's made, and lapses
then unless a move landed. Its `/v1/*` is the pool's model API, which that
server's harnesses use instead of their own hub. It forwards through the same
`forwardModel` as gateway turns, with the grant checked on every request, but
reaches the pool object straight from the cloud Worker; #158 moves self-hosted
use onto the gateway.

`wrangler dev` and the Alchemy deploy build the image with Docker, so local
development needs Docker running. Containers need the Cloudflare account on the
Workers Paid plan; on any other plan every deploy fails at
`/containers/me`. Each preview gets its own container application,
`signalbox-cloud-pr-<number>-pools`, deleted with the preview.

### Drives

Each person has a My Drive in every context, work organizations have shared
drives, and a folder shared from a My Drive is split out into a drive of its
own (`apps/cloud/src/drive/`). Every drive is a project in the shell, and a
thread works in the drive it was started in for good. A drive
is a git repository with no git server: packs in the `DRIVE_PACKS` R2 bucket
(`signalbox-drives`, previews `signalbox-drives-preview`, both in the EU
jurisdiction), refs in the drive's `DriveObject`. Preview pack keys start with
`pr-<number>/`; production keys have no prefix. The Runner checks the thread's
branch out as the harness's working directory, uploads one pack and moves
`wip/<thread>` after each batch of tool calls, and at the end of a turn
merges `main` into `threads/<thread>` and fast-forwards `main`. A merge
conflict goes back to the agent as one more step of the same turn. Clients
browse `main` and each turn's diff through the Worker, with no machine
running.

Each save also keeps the thread's machine state on `machine/<thread>`
(`RunnerMachineState.ts`, #490): checkout files the auto-save leaves out
because git ignores them (`.env`, `notes/`, local databases), and the thread's
home and harness config, minus what the Runner writes at every start and the
session transcripts saved on their own. A new machine, on any backend, puts it
back before the first turn. Its packs are private to the thread
(`packs.private_to`): only that thread's machines are handed them, only that
thread's packs may lean on their objects, and nothing merges or pushes the
ref, so secrets never reach another thread or a Git host. A cloud from before
this answers no `machine` ref, and the Runner then keeps none. Rolling the
Worker back past it would hand private packs to every thread in the drive.

Changes stream in as they happen (#493), not only after tool calls and at
turn end: every 2 s the Runner asks whether anything it keeps is newer than
its last successful save (`RunnerDriveWatch.ts`, a `find` that stops at the
first hit) and saves if so, so a machine lost without warning loses about
that much. A save that keeps failing tells the thread once, and again when it
works. Before the cloud lets an idle machine go, it sends `drain`: the
Runner saves the drive and the session rows with its tokens still good and
answers `machine.drained` with the drain's id, and only then is the lease
released; a reconnecting Runner is asked again. A machine that doesn't answer
within 2 minutes goes anyway, and the session's stop detail says its last
saves weren't confirmed. Only Runners whose `hello` says they drain are
asked; an older one is let go as before. A machine stopping on its own
side (SIGTERM, a newer generation, a new image) saves the same way as its
session closes, within 25 s.

Three invariants hold the store together, all enforced by the Worker and the
cloud's objects rather than trusted to the Runner:

- **Objects before refs.** An upload is checked object by object, stored in
  R2, and only then indexed; a pack is refused unless everything its commits
  and trees reference is in it or already indexed. A ref can only name an
  indexed commit, so a machine killed mid-upload leaves at most an orphaned
  file in R2.
- **Whose refs.** The drive token (`drive/driveToken.ts`) names one thread and
  machine generation. That thread moves only `threads/<thread>`,
  `wip/<thread>` and `machine/<thread>`, and `main` only as a fast-forward to its own branch while its
  turn runs. An older generation writes nothing once a newer one has.
- **Who reaches a drive.** Two authorities, asked on every request and cached
  nowhere: the drive object's members (`drive/DriveMembers.ts`) and, for a
  work organization's drive, the person's own contexts in their user object
  (`user/UserDrives.ts`). Removing someone from either cuts browsing, their
  threads' machines and new threads at once. The drive object delivers
  membership changes to each person's sidebar from its alarm, but access never
  waits on that delivery.

A drive can hold shortcuts: paths that show another drive (#142). A folder
split out to be shared leaves one behind, and people who can change a drive
add their own. The Runner mounts each target the thread's user can open as a
read-only repository of its own at that path, and keeps the path out of the
drive's own repository, so nothing under a shortcut ever lands on the drive's
`main`. Drives backed by GitHub hold no shortcuts. The targets' `AGENTS.md`
files are bundled into a generated `AGENTS.md` in the folder above the
checkout (`workspaces/<thread>/`), outside the drive: Codex takes that folder
as its project root and Claude Code reads parent folders, so both load it
beside the drive's own. When the bundle changes, the Runner restarts the
harness session so its native resume swaps the instructions in.

### Folders

A user's tree lives in their user object (`apps/cloud/src/user/UserFolders.ts`,
#227): folders nest freely under the top level, each in one owner's tree
(Personal or an organization). Every drive someone is given gets a folder of
its own once (`folder_drives`), which uses the drive as its files. A thread's
home is the folder it was filed in, else the folder whose files it works in,
else the top level. Filing a thread moves only its home: it keeps working in
the drive it started in, but its next turn runs on the new home's chain.

The chain decides three things per turn, all resolved in the user object when
a command can start a turn and handed to the thread object with it: the
nearest pool (`poolChain.ts`), every level's instructions, top level first, and
every level's secrets (below). The
thread object keeps each run's instructions (`run_instructions`) and
sends them with the drive access; the Runner puts them first in the generated
`AGENTS.md` above the checkout, before the shortcuts' and the drive's own. They
count toward the same 64 KiB.

`0013` turned sections into folders with the same ids, so pools placed at
sections or projects still apply (`ResourceBindings` reads both as folders).
Clients from before folders still get `sections.*`, served as a view of the
folders (`legacySections.ts`). A pool placed at a folder made since is stored
as a `folder` level, which a build from before folders can't read.

`wrangler dev` keeps the bucket locally. Both buckets are in the stack and
retained: no stage's destroy ever deletes one, and every stage that declares
them keeps their settings (no lifecycle rules, CORS or public access).

The preview bucket may still contain keys written before PR prefixes existed.
A preview whose prefixed read misses falls back to the unprefixed key, so
previews deployed before prefixes keep their packs across redeploys; new packs
are always written under the prefix. Run the `Sweep Signalbox Cloud Previews`
workflow manually with `cleanup_legacy_preview_packs` enabled once, after every
preview that was open when prefixes landed has closed (a redeploy isn't enough:
it still reads the old keys). It deletes only unprefixed keys in
`signalbox-drives-preview`.

### Chats and tasks

Each user object keeps whether their threads are chats or tasks
(`apps/cloud/src/user/UserThreadKinds.ts`, #46). A thread's first message is
classified once, before its turn starts, by a semantic decision model: Jev
(`TYPESAFE_API_KEY`) or OpenAI's Decisions API (`OPENAI_API_KEY`). With both
keys set, Jev is asked unless `THREAD_KIND_CLASSIFIER=openai`. Without either,
nothing is classified and every thread stays a task. The call times out after
1.5 seconds and its span carries no title or message text. The question is the
one the classifier benchmark measured, so change it only with a new run.

Idle chats archive themselves on the user object's alarm, which only this
uses. Threads from before kinds have no record and stay tasks. Previews and `wrangler dev` set
`THREAD_KIND_TEST_CLOCK=1`, which serves `POST /api/cloud/thread-kinds/sweep`
with `{"asOf": "<ISO time>"}`: it runs the caller's sweep as if it were that
time, so archiving can be tried without waiting a week. Everywhere else the
route is a 404.

### Attachments

Pasted screenshots and files share the drives bucket, under
`<preview prefix>attachments/` (`apps/cloud/src/attachments/`), so a preview's
attachments go with its prefix. A client uploads to a signed URL and gets a
`pending-…` id, stored under `attachments/pending/`; sending the message copies
each upload under an id of the thread, derived from the command so a retry
rewrites the same copy. Uploads nobody sent are swept after a day, beside the
next upload; an R2 lifecycle rule on `attachments/pending/` would do the same
without the sweep. Clients load a sent attachment through the same signed
`/api/assets` URLs as tools' images (`apps/cloud/src/assets/`), issued only to
its uploader and to people who can see its thread. Limits are the contract's (`chatAttachment.ts`): 10 MiB
per image, 50 MiB per file, 80 MiB of images and 100 attachments per message.
Before each turn the Runner downloads every attachment the thread's messages
hold into the adapters' attachments directory with its session token, so a
new machine after a sleep has the earlier ones too.

### Secrets

A level can name a 1Password Environment (#395): the threads on its chain get
its variables as environment variables. The user object stores only the
Environment ids and the user's 1Password service account token. The thread
object keeps the chain's ids per thread and reads the token from the user
object each time it hands a turn out, so a replaced token needs no restart.
`turn.start` carries both (`SecretsProtocol.ts`).

The Runner reads the Environments, because 1Password's SDK only runs in Node:
it loads a WebAssembly core from beside itself. So it stays out of the Runner's
bundle and the Runner image installs it next to `runner.mjs`. Bump
`ONEPASSWORD_SDK_VERSION` in the Dockerfile with the version `apps/server`
pins. The Runner reads when a harness session starts and what the turn names
changed (or the last read fell short). Changed variables restart the harness
session, resumed natively, like changed instructions. A value changed in
1Password reaches a thread on its next machine.

Values never leave the machine as they are. The host's mask
(`apps/server/src/signalbox/runner/secretMask.ts`) replaces every value
1Password hides by default, and the token, with `***` in every frame, every
session row and the Runner's own log. Values of 6 characters or fewer stay
unmasked. Spans and wide events carry counts, never names or values. A
variable the harness environment sets, or one that would take Claude Code off
the ModelGateway (`ANTHROPIC_API_KEY` and the like), is skipped, and the turn
says so.

Service accounts are rate limited per 1Password account: 1,000 requests a day
on Individual and Families, 5,000 on Teams, 50,000 on Business. Each read is a
sign-in plus one request per Environment.

### What an agent reads beyond its drive

An agent reads every drive its user can, across contexts, and changes only its
own (#141). The Runner runs a context server on a loopback port
(`apps/server/src/signalbox/runner/RunnerContextServer.ts`). It serves the
`signalbox` MCP server, which Claude gets per query and Codex in its
`config.toml`, and serves `/drives` as read-only WebDAV, which `rclone mount`
turns into the folder `/drives/<context>/My Drive`, `…/Shared drives/<name>`
and `…/Shared with me/<name>`. Both read through the cloud's context API
(`apps/cloud/src/context/`, under `/api/drive/context/`) with the thread's
drive token. The token never leaves the Runner, and the user's object is asked
which drives they can read on every call. At each turn start the Runner takes
a new view that pins every drive to its `main`, so a turn reads one version
of everything.

The context tool's search covers the user's own threads (titles, changed
files, whole conversations), each drive's `main` history, and other threads'
work that hasn't reconciled yet. Others' threads stay unnamed. Every source is
capped, and the answer says how much it read. Results must hold most of the
query's words (`context/contextMatch.ts`); otherwise the answer is
`insufficient_evidence`.

The mount needs FUSE. The Runner image ships `rclone` and `fuse3`, and boat's
unit script runs the container with `/dev/fuse` and `SYS_ADMIN` when the VM
has FUSE. A VM created before that script changed keeps its old unit and runs
without the mount until it is recreated. Without FUSE, `list_drives` and
`read_drive_file` read the same paths. To try the mount locally, run the
Runner host in the image under Docker with `--device /dev/fuse --cap-add
SYS_ADMIN --security-opt apparmor=unconfined` and `--drives /drives`.

### Drives backed by GitHub

A user can import a GitHub repository (Settings › Source Control, then Add
project › GitHub repository). It becomes a shared drive in Personal, with the
user as its manager and the repository recorded on the drive, so it can be
shared like any drive. Its drive keeps GitHub as its home
(`apps/cloud/src/github/`, `drive/remoteRoutes.ts`):

- **`main` mirrors the default branch**, one commit deep. At each turn start
  the Runner fetches GitHub's history blobless (commits and folders, files on
  demand) through the cloud, uploads the default branch's head with its
  folders, and `mirror`s `main` to it. The Worker checks both against what
  GitHub says the head is right now, so `main` only ever follows GitHub. A new
  thread's branch starts there.
- **The drive keeps GitHub's files on GitHub** (#406). A head's files the
  drive lacks are recorded as promised. The files panel, search and `/drives`
  read them from GitHub as the reader, checked against their ids and cached.
  A thread's checkout is a partial clone with the cloud's fetch proxy as its
  promisor, so git fetches them as it needs them.
- **Agents work with the whole history** (#394): `git log`, `blame`, `fetch`,
  `pull` and `rebase origin/main` reach GitHub through `origin`. A rebased
  branch saves with the newer main it sits on, one commit deep; the Worker
  checks GitHub has each such commit. Pushing still goes through the cloud,
  and replaces the branch on GitHub only when it holds nothing the thread
  hasn't fetched (a lease).
- **Threads never reconcile.** A turn's commit stays on `threads/<id>`. The
  user pushes it, or opens a pull request, from the thread's git panel. The
  user's object builds the push from the drive's packs and sends it over git's
  smart HTTP, with no machine running. Only the thread's branch is pushed
  (`signalbox/<id>`), so auto-saves never reach GitHub.
- **The agent publishes through the same path.** The context MCP's `push` and
  `create_pr` commit the worktree onto the thread's branch, save it, then post
  `/api/drive/branch/publish` with the drive token. The thread and drive come
  from the token, never the request, and the owner's object runs the git
  panel's `GitHubBranches.publish` (`runner-protocol/src/BranchProtocol.ts`).
- **The pull request it opens is linked to the thread, and the thread keeps
  it current.** The thread object's alarm reads linked pull requests from
  GitHub with the owner's token (`thread/pullRequests/PullRequestSync.ts`),
  and a change goes out as `thread.pull-request-synced` with the whole thread,
  never upstream's `thread.pull-request-link-updated`: automations derive
  `pr.*` facts from `thread.pull-request-synced` only.
- **No GitHub credential reaches a machine.** Users connect GitHub through
  WorkOS Pipes, which keeps and refreshes their OAuth tokens. Their own object
  only records that they connected, and as whom, and asks Pipes for a token
  each time the cloud acts as them. A machine fetches through
  `/api/drive/remote`, which takes fetches only, with a remote token that is
  good only while its turn runs. The cloud adds the user's token on the way to
  GitHub. The Runner hands the remote token to git through a credential
  helper reading a file next to, never inside, the thread's working
  directory, so nothing in the workspace holds it.
- **A connection counts once the browser that started it comes back.** A
  Pipes authorize link connects whoever opens it to the user who made it, so
  `/api/github/callback` checks a one-time grant cookie and aborts (deleting
  the WorkOS connection) when the return lands anywhere else
  (`github/GitHubConnection.ts`).

The Worker needs only `T3CODE_WORKOS_API_KEY`, plus a GitHub integration in
that WorkOS environment's Pipes:

- **Provider:** GitHub (slug `github`), user-owned, enabled.
- **Scopes:** `repo`, `workflow`, `read:org`, `read:user`, `user:email`.
- **Credentials:** a GitHub OAuth App whose callback URL is the redirect URI
  WorkOS shows for the integration, with token expiration opted out (Optional
  features). Signalbox hands the token to the user's Executor once, and
  Executor can't swap a credential in place, so an 8-hour token would break
  there. The hosted service's App is "Signalbox" under `JustYannicc`.

Production, previews and local development share it, because the callback is
WorkOS's, not the cloud's. Organizations that restrict OAuth Apps have to
approve Signalbox before their repositories show up.

### Exact resume

A machine can die at any moment, so the harness's own session leaves it as
it is written (#132): Claude Code's transcript and subagent sidecars through
the Agent SDK's `SessionStore` (eager flush), Codex's rollout files by tailing
them. The Runner streams the rows verbatim to the thread's object, which keeps
them in its own SQLite (`apps/cloud/src/thread/session/`, tables that create
themselves rather than a `ThreadStore` migration). Rows land only directly
after the stored ones, so the store is always a gapless prefix of what the
harness wrote, and only the machine holding the lease can write.

- A message or tool result the thread shows as complete has its rows stored
  first. Claude writes a message's row 30 to 120 ms after streaming it, so the
  Runner holds each message until its row is durable.
- If saving stalls for 30 s, or the SDK reports `mirror_error`, the Runner
  stops the turn with a notice. The rows stay queued and land once the store
  answers again.
- When the machine running a turn is lost (its socket stays gone for 60 s, or
  it says `end`), the run ends interrupted, with anything still streaming
  shown aborted, and a continuation run (`restartContinuationOfRunId`) starts
  on the next machine. A new Runner process on the same machine counts as
  well: boat can bring a resumed disk up on another node, and that Runner
  dials in with the same generation before the 60 s are up. Its `hello` lists
  the runs it was handed, so a started run missing from it continues on that
  machine. That machine restores the session at its latest
  durable row and the worktree at its latest auto-save, then resumes natively.
  A tool that was running is reported to the model as unfinished by the
  harness itself and never rerun. After three lost machines in a row, or when
  the harness never started the run, the run fails instead.

To watch it locally, kill the Runner host while a turn runs and start another
one with an empty `--home`: about a minute later the turn goes on there.

### Why a turn failed

Every turn has a trace id: 32 hex characters derived from its run id. The
same id is on the command receipt that started the turn, the `turn.start` the
Runner gets (and its own logs), the ModelGateway's `model_gateway.request` log
lines, and the turn's diagnostic record. The thread object writes that record
as it goes. It holds the machine generations the turn ran on, with backend,
machine id, image, digest, Runner revision and `claude`/`codex` versions, how
each one woke and stopped, and every backend answer. It also holds the
Runner's own error lines (redacted), each model request with its status and
tokens, CPU and memory, and the harness's session refs.

- Ask the thread's object, signed in as its owner:
  `GET /api/cloud/threads/<thread id>/diagnostics` lists recent turns with
  their trace ids and failures, and `.../diagnostics/<trace, run or command id>` returns
  one record.
- In Workers Logs, search for the trace id. When a turn ends, its object logs
  the whole record as `cloud turn diagnostic`.

### Usage analytics

With `SIGNALBOX_POSTHOG_KEY` set (and `SIGNALBOX_POSTHOG_HOST` for a non-US
project), thread objects send `cloud.turn.completed` per turn and
`cloud.machine.session` per machine wake to Signalbox's PostHog. These are the
#116 events the cost replay reads. Ids are hashed and nothing carries content,
paths or command text. `T3CODE_TELEMETRY_ENABLED=false` turns them off. The
deploy passes both variables from the `cloud-production` environment only, so
previews send nothing. CPU, memory, disk and egress are measured in the
Runner's container on the VM, so a local Runner host on a Mac reports none.

### Push notifications

The cloud pushes to phones itself, straight to APNs and FCM, not through the
Signalbox Connect relay: the relay keys devices to its own Clerk accounts, and cloud
people are WorkOS users. A phone registers over its cloud socket
(`signalbox.push.registerDevice`, the relay's registration payload) and the
person's object keeps it for that session; signing out silences it. The
person's object decides on each thread summary it indexes
(`apps/cloud/src/push/pushRules.ts`), so pushes go out whether or not any
client is open.

| Name                  | Kind   | What                                                     |
| --------------------- | ------ | -------------------------------------------------------- |
| `APNS_TEAM_ID`        | var    | The Apple team that signs the app                        |
| `APNS_KEY_ID`         | var    | The APNs auth key's id                                   |
| `APNS_PRIVATE_KEY`    | secret | The APNs auth key (`AuthKey_<id>.p8`), PEM               |
| `FCM_SERVICE_ACCOUNT` | secret | Optional. A Firebase service account's JSON, for Android |

The deploy passes all four from the GitHub environment (`cloud-production`,
`cloud-preview`). Without them that platform's pushes are skipped and logged
as `push not delivered`. One APNs key serves sandbox and production builds of
every bundle id in its team. The topic is the bundle id the phone reports.

### Dependency and build caches

A machine's caches live on its disk next to the checkouts, never in a drive.
Package-manager stores and download caches (pnpm's store, npm's cache,
Corepack, `XDG_CACHE_HOME`) are under `caches/<toolchain>` in the machine's
home (`apps/server/src/signalbox/runner/RunnerCaches.ts`), one directory per
OS, libc, architecture and Node major, and the harnesses see them through the
environment. Before each turn, after the checkout is synced, the Runner finds
every pnpm, npm, Yarn or Bun lockfile up to two folders deep and keys it on the lockfile,
the package manager's other install inputs and the toolchain
(`RunnerDependencies.ts`). An unchanged key reuses `node_modules` and the
build caches tools keep in it. A changed key, or an install that never
finished, discards every `node_modules` under that folder and installs fresh
from the warm store, so nothing built against the old dependencies survives.
An install that failed is not retried until its key changes. A thread's
branch never holds `node_modules`, whatever the repository's own ignore files
say, and its machine state leaves out exactly the trees this rebuilds, keeping
files edited after their install and putting them back once a rebuild lands on
the same key. A `node_modules` no lockfile rebuilds is kept like any other
folder. The image enables Corepack, so a project's `packageManager` picks the
pnpm or yarn the agent's shell runs, and carries Bun.

## Deploying

Everything the cloud runs on is one Alchemy stack, `apps/cloud/alchemy.run.ts`:
both Workers, the Durable Objects, the thread and pool containers, the drive
buckets, secrets and custom domains. `.github/workflows/deploy-cloud.yml`
deploys one stage of it (`apps/cloud/infra/stage.ts`):

- **Production:** every push to `main` that touches the cloud or what it serves,
  and manual runs from `main`, deploy the `production` stage at
  `app.signalbox.run`.
- **Previews:** same-repository pull requests opened by `JustYannicc` deploy the
  `pr-<number>` stage at `preview-<number>.signalbox.run`. Each preview is its
  own Worker (`signalbox-cloud-pr-<number>`) with its own Durable Objects, so it
  never shares users or sessions with production. Closing the pull request
  destroys the stage. The same run plans the `production` stage, so the pull
  request shows what merging it would do to production.

Every deploy plans first (`alchemy deploy --dry-run`, in the job summary) and
stops if the plan would replace, delete, orphan or unbind anything
(`apps/cloud/infra/check-plan.ts`). Production's names, binding names and class
names are what hold everyone's data: a renamed Worker or binding is a new,
empty Durable Object namespace. Production's resources are also retained, so
even a destroy only drops them from Alchemy's state.

Alchemy keeps its state in the account (`Cloudflare.state()`: an
`alchemy-state-store` Worker and the account's Secrets Store). It manages
Durable Object migrations itself, so new Durable Object classes go in the stack
as a new binding; the `migrations` in `wrangler.jsonc` are for `wrangler dev`.

Closing a pull request also deletes its R2 prefix and removes its pool links
from production. The close workflow destroys the preview's stage first (and
deletes any Worker or container a wrangler-era preview left), then asks
production for the rest; if production's cleanup
route fails, the job goes red and the weekly sweep retries. Reopening a pull
request clears its closed-link marker before deploying the preview again.

Production finds a preview's links through a registry that pools record into
when they make or serve one. Links made before the registry existed aren't in
it. The sweep's one-off `backfill_preview_links` option asks every production
PoolObject to drop links for pull requests closed in the last 90 days; run it
once, after the previews open when the registry landed have closed. Anything it
misses expires within 90 days.

Both read from a GitHub environment. `cloud-production` is limited to `main`;
`cloud-preview` holds the same names, with `CLOUD_PREVIEW_SESSION_SECRET`, from
which each preview derives its own session secret.

| Name                           | Kind     | What                                                                                                 |
| ------------------------------ | -------- | ---------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`         | secret   | Account › Workers Scripts, Containers, Workers R2 Storage, Secrets Store and Account Settings: Edit  |
| `CLOUDFLARE_ACCOUNT_ID`        | variable | The Cloudflare account                                                                               |
| `CLOUD_SESSION_SECRET`         | secret   | Signs sessions and seals sign-in state. Rotating it signs everyone out.                              |
| `T3CODE_WORKOS_CLIENT_ID`      | variable | WorkOS client id                                                                                     |
| `T3CODE_WORKOS_API_KEY`        | secret   | WorkOS API key: email verification (GitHub sign-ins), work contexts and sharing                      |
| `T3CODE_WORKOS_WEBHOOK_SECRET` | secret   | Optional. Verifies WorkOS's membership webhook (below)                                               |
| `VITE_T3CODE_FEEDBACK_DSN`     | variable | Sentry DSN for the sidebar feedback button, baked into the web build                                 |
| `TYPESAFE_API_KEY`             | secret   | Optional. Jev, which tells chats from tasks ([Chats and tasks](#chats-and-tasks))                    |
| `OPENAI_API_KEY`               | secret   | Optional. OpenAI's Decisions API, the other chat or task classifier                                  |
| `KERNEL_API_KEY`               | secret   | Optional. Kernel, which runs each person's browser for real sites; unset, machines browse headless   |
| `EXECUTOR_LOGIN_SERVICE_URL`   | var      | Optional. Executor's origin for agents' sign-ins from 1Password (`src/signIn/`); needs the token too |
| `EXECUTOR_LOGIN_SERVICE_TOKEN` | secret   | Optional. Executor's `EXECUTOR_LOGIN_SERVICE_TOKEN`; unset, `sign_in` says it can't read logins      |

The production deploy derives the preview-cleanup token from
`CLOUDFLARE_API_TOKEN`. Keep the same token value in both GitHub environments
so preview workflows can call the production cleanup route. The route never
receives the Cloudflare token itself.

WorkOS must list each origin's `/api/account/callback` as a redirect URI:
`https://app.signalbox.run/...` for production and
`https://*.signalbox.run/...` for previews.

Leaving an organization takes away its drives and threads once the cloud
hears of it. Without a webhook that's the person's next sign-in. To make it
immediate, add a WorkOS webhook endpoint for
`https://app.signalbox.run/api/workos/webhook` with the
`organization_membership.created`, `.updated` and `.deleted` events, and store
its signing secret as `T3CODE_WORKOS_WEBHOOK_SECRET`. Previews don't receive
it.

`ENVIRONMENT_ID` in `apps/cloud/infra/stage.ts` is the cloud's identity. Clients key saved
connections on it, so never change it for a live deployment.

### Durable Object migrations

Each object migrates its own SQLite when it starts
(`apps/cloud/src/storage/migrations.ts`). A migration runs unless its full name
is recorded, so an object that once ran a branch's `0009_a` still gets main's
`0009_b`, and two branches can take the same number without renumbering.
Never edit, rename or remove a merged migration; add another.

The Cloud Migrations CI check fails a pull request that does, and reports
whether its new migrations are additive, so the previous version still runs on
the migrated schema, or ship-only. Additive means new tables and indexes, new
columns that are nullable or have a default, and rows in tables the same pull
request creates. Anything else is ship-only, including a new Durable Object
class (an entry in `migrations` in `wrangler.jsonc`). Ship-only never blocks.

### What a preview starts with

A preview has its own Durable Objects, so it starts empty. Signing in to one
in a browser takes your production setup along (`apps/cloud/src/previewSetup/`):
the preview sends the browser through `app.signalbox.run`, which, if you're
signed in there, hands it a one-time claim bound to you, that preview's origin
and a verifier only the preview holds. The preview redeems it with production,
server to server, and takes in the setup. Not signed in on production, or
signed in as someone else, sign-in just goes on. No secret is shared with pull
request builds: production lists the origins it answers in
`PREVIEW_SETUP_ORIGINS`, previews name production in `PREVIEW_SETUP_SOURCE`
(both in `apps/cloud/infra/stage.ts`).

- **Pools are links, not copies.** Each of your pools on the preview, under the
  same id, is backed by a preview link into production's pool, so production
  stays the only thing refreshing the accounts' tokens, and accounts added
  there show up at once. Add and manage accounts on production; the preview
  refuses. Every sign-in to the preview renews the links (90 days each) and
  links pools new since.
- **Copied once:** folders with their instructions, the pool placed at each
  level (from a production from before folders: its sections, read into
  folders), the GitHub connection (Pipes keeps the tokens under your WorkOS
  user, which both share), each level's 1Password Environment and your
  1Password service account token, unless the preview has one already.
  Changes on the preview stick.
- **Not copied:** threads, sessions, grants, the thread index, drives, Executor
  connection links (they're bound to the cloud that issued them) and anything
  running. Folders keep no files the preview doesn't have; import a GitHub
  repository again to get its drive, which gets a folder of its own.
