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

Each thread and port gets its own origin, `<label>.<PREVIEW_DOMAIN>`, because
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

To turn previews on for a deployment, it needs a domain whose subdomains reach
the Worker:

1. Pick the domain. Use a registrable domain of its own (the way GitHub serves
   user content from `githubusercontent.com`), so preview pages aren't
   same-site with `app.signalbox.run`. Subdomains of `signalbox.run` also work,
   but are same-site with the app.
2. In its Cloudflare zone, add a proxied wildcard DNS record (`*`) and a
   Worker route `*.<domain>/*` for `signalbox-cloud` (in `wrangler.jsonc`'s
   `routes`, so deploys keep it). Universal SSL covers one level of
   subdomains.
3. Set the `PREVIEW_DOMAIN` variable in the `cloud-production` GitHub
   environment. The deploy passes it; unset, previews are off and clients hide
   the control.

Pull request previews don't serve dev-server previews: each would need a
wildcard domain of its own.

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
  (`containers` in `wrangler.jsonc`, `basic`: ¼ vCPU, 1 GiB, 4 GB disk),
  started in about a second with a fresh disk and stopped after a 30-second
  idle tail. Its files come from the drive and its session from the thread,
  so the fresh disk loses nothing. The container stops by itself ten minutes
  after its object goes idle, so a thread object that is gone cannot leak one.
  It runs the Runner image built with the Worker: the deploy bundles the
  Runner (`vp run runner:bundle` in `apps/server`) and wrangler builds
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
interrupted and the agent runs it again there. A light container that exits
mid-turn moves its run up too.

Each preview gets its own container application,
`signalbox-cloud-pr-<number>-threads`, deleted with the preview. Containers
need the Cloudflare account on the Workers Paid plan.

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
for every `vX.Y.Z` tag. Run it by hand to publish one now. Pull requests
from this repository publish `pr-<number>`, and their preview's heavy
machines run it; a machine started before that build lands fails to pull and
works once started again.

Machines pull the image anonymously, so the package must be public: after its
first publish, set its visibility once under the package's settings on GitHub.
A machine follows `RUNNER_IMAGE` at its next wake. Bump the Runner protocol
only together with a published image, since a machine on an older image is
refused.

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
which lists only what its enabled accounts can run), read and cached with the
pool's accounts. The model manifest the self-hosted server uses names them and
gives them their options; the Worker fetches it from upstream hourly and falls
back to its bundled copy. So a CLIProxyAPI bump is what brings new models; the
manifest only names them, and a model it doesn't know yet shows under its slug.
A turn on a model its pool doesn't serve is refused at turn start
(`thread/TurnModels.ts`). The scripted provider, a reply without a model, is
offered only where `SCRIPTED_PROVIDER=1`: `wrangler dev` and tests, never
production.

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

`wrangler dev` and `wrangler deploy` build the image with Docker, so local
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

Three invariants hold the store together, all enforced by the Worker and the
cloud's objects rather than trusted to the Runner:

- **Objects before refs.** An upload is checked object by object, stored in
  R2, and only then indexed; a pack is refused unless everything its commits
  and trees reference is in it or already indexed. A ref can only name an
  indexed commit, so a machine killed mid-upload leaves at most an orphaned
  file in R2.
- **Whose refs.** The drive token (`drive/driveToken.ts`) names one thread and
  machine generation. That thread moves only `threads/<thread>` and
  `wip/<thread>`, and `main` only as a fast-forward to its own branch while its
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

The chain decides two things per turn, both resolved in the user object when a
command can start a turn and handed to the thread object with it: the nearest
pool (`poolChain.ts`), and every level's instructions, top level first. The
thread object keeps each run's instructions (`run_instructions`) and
sends them with the drive access; the Runner puts them first in the generated
`AGENTS.md` above the checkout, before the shortcuts' and the drive's own. They
count toward the same 64 KiB.

`0013` turned sections into folders with the same ids, so pools placed at
sections or projects still apply (`ResourceBindings` reads both as folders).
Clients from before folders still get `sections.*`, served as a view of the
folders (`legacySections.ts`). A pool placed at a folder made since is stored
as a `folder` level, which a build from before folders can't read.

`wrangler dev` keeps the bucket locally. Deployments need both buckets
created once (`wrangler r2 bucket create signalbox-drives --jurisdiction eu`,
and the same for `-preview`); without them the deploy fails.

The preview bucket may still contain keys written before PR prefixes existed.
A preview whose prefixed read misses falls back to the unprefixed key, so
previews deployed before prefixes keep their packs across redeploys; new packs
are always written under the prefix. Run the `Sweep Signalbox Cloud Previews`
workflow manually with `cleanup_legacy_preview_packs` enabled once, after every
preview that was open when prefixes landed has closed (a redeploy isn't enough:
it still reads the old keys). It deletes only unprefixed keys in
`signalbox-drives-preview`.

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
  the Runner fetches GitHub's `HEAD` through the cloud, uploads that commit
  with its whole tree, and `mirror`s `main` to it. The Worker checks both
  against what GitHub says the head is right now, so `main` only ever follows
  GitHub. A new thread's branch starts there.
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
- **No GitHub credential reaches a machine.** Users connect GitHub through
  WorkOS Pipes, which keeps and refreshes their OAuth tokens. Their own object
  only records that they connected, and as whom, and asks Pipes for a token
  each time the cloud acts as them. A machine fetches through
  `/api/drive/remote`, which takes fetches only, with a remote token that is
  good only while its turn runs. The cloud adds the user's token on the way to
  GitHub. The Runner passes the remote token to that one `git fetch` in its
  environment, and never writes it to disk.
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
  on the next machine. That machine restores the session at its latest
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

Closing a pull request also deletes its R2 prefix and removes its pool links
from production. The close workflow removes both Workers and both container
applications first, then asks production for the rest; if production's cleanup
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

| Name                           | Kind     | What                                                                                             |
| ------------------------------ | -------- | ------------------------------------------------------------------------------------------------ |
| `CLOUDFLARE_API_TOKEN`         | secret   | Account › Workers Scripts: Edit, Account › Containers: Edit and Account › Account Settings: Read |
| `CLOUDFLARE_ACCOUNT_ID`        | variable | The Cloudflare account                                                                           |
| `CLOUD_SESSION_SECRET`         | secret   | Signs sessions and seals sign-in state. Rotating it signs everyone out.                          |
| `T3CODE_WORKOS_CLIENT_ID`      | variable | WorkOS client id                                                                                 |
| `T3CODE_WORKOS_API_KEY`        | secret   | WorkOS API key: email verification (GitHub sign-ins), work contexts and sharing                  |
| `T3CODE_WORKOS_WEBHOOK_SECRET` | secret   | Optional. Verifies WorkOS's membership webhook (below)                                           |
| `VITE_T3CODE_FEEDBACK_DSN`     | variable | Sentry DSN for the sidebar feedback button, baked into the web build                             |

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

`ENVIRONMENT_ID` in `wrangler.jsonc` is the cloud's identity. Clients key saved
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
request creates. Anything else is ship-only, including a new entry in
`migrations` in `wrangler.jsonc`. Ship-only never blocks.

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
(both in `wrangler.jsonc`).

- **Pools are links, not copies.** Each of your pools on the preview, under the
  same id, is backed by a preview link into production's pool, so production
  stays the only thing refreshing the accounts' tokens, and accounts added
  there show up at once. Add and manage accounts on production; the preview
  refuses. Every sign-in to the preview renews the links (90 days each) and
  links pools new since.
- **Copied once:** folders with their instructions, the pool placed at each
  level (from a production from before folders: its sections, read into
  folders), and the GitHub connection (Pipes keeps the tokens under your WorkOS
  user, which both share). Changes on the preview stick.
- **Not copied:** threads, sessions, grants, the thread index, drives, Executor
  connection links (they're bound to the cloud that issued them) and anything
  running. Folders keep no files the preview doesn't have; import a GitHub
  repository again to get its drive, which gets a folder of its own.
