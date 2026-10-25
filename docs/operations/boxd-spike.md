# Boxd connectivity and lifecycle spike

This is an opt-in Alchemy stack for #915. It does not serve product threads or run
our Runner. It tests `@boxd-sh/sdk/web` from a Worker and a singleton Durable Object
against `https://boxd.sh:9443`. Local tests cannot establish that Cloudflare can
reach that port. The account key in #916 gates that proof.

Use a separate boxd account or org with no valuable machines. The probe creates
one source and one fork, plus a temporary snapshot. Never reuse its stage name.
The stage owns exactly `<owner>-source`, `<owner>-clone`, and `<owner>-snapshot`,
where owner is `sb-<stage>`. A preflight refuses existing names. Before each
allocation the object records ownership and intent. After an ambiguous response
it only looks up that name, rather than repeating create, fork or snapshot.

## Deploy and run

The #915 owner runs this after provisioning #916. Supply `BOXD_API_KEY` and a
random `BOXD_PROBE_TOKEN` of at least 32 characters through the private deployment
environment. Alchemy binds both as secrets. Do not pass them as CLI arguments,
commit them, paste them in chat, or enable shell tracing.

Optional settings:

- `BOXD_PROBE_ORG`: account org name, empty for personal quota. Prefer an org key.
- `BOXD_PROBE_IMAGE`: an approved listener-free Linux image with Python 3,
  `flock`, and `sleep`. Empty uses the boxd default image.
- `BOXD_PROBE_LIFETIME_SECONDS`: 300–3600, default 900. This is a fixed run deadline.
- `BOXD_PROBE_EGRESS`: JSON array of allowed hosts. Default `["example.invalid"]`
  admits no useful internet traffic. The workload needs no outbound network.

From `apps/cloud`, use a unique random suffix of 8–20 lowercase letters or digits:

```sh
./node_modules/.bin/alchemy deploy infra/boxd-spike.alchemy.ts \
  --stage boxd-spike-<unique-id> --yes --no-input
```

Use the returned Worker's workers.dev origin. Every request requires
`Authorization: Bearer <BOXD_PROBE_TOKEN>`. Keep that header in a private HTTP
client or a temporary curl config readable only by you, rather than putting the
secret in a command argument. No cookies or query tokens authorize this stack.
There is no CORS policy allowing browser clients. The token grants only this
single disposable run; callers cannot choose names, IDs, commands or images.

1. `POST /worker-connect` tests the Worker's SDK gRPC-web request. Save its safe
   `durationMs` response outside the repository.
2. `POST /advance` executes or observes one step. Repeat until `/status` reports
   `run.done`. A successful run also has `run.failure: null` and all timings finished.
   `done` with a failure means cleanup finished, not that the spike passed. The first
   step tests the DO's SDK connection. Poll pending steps with
   further requests; the Worker does not sleep waiting for readiness.
3. `GET /status` returns the persisted run and Worker connectivity records.
   Each run timing has `startedAt`,
   `finishedAt`, `calls`, and `activeMs`. `activeMs` sums time inside step calls;
   `finishedAt - startedAt` also includes time between requests. Preserve this
   record with the Worker connectivity measurement as the live evidence.
4. `POST /archive` aborts and destroys the run's resources. It is safe to repeat.

The lifecycle is create, verify privacy, start a fake lease process, hibernate,
wake, snapshot, fork, verify fork privacy, prove lease clearing and fresh config,
read usage, release by hibernating, and archive by deletion. A mismatched process
PID after wake or fork fails the probe. Usage is an early estimate in micro-units,
not a final bill; boxd metering can lag. Pricing and account limits from #927 do
not require changing the lifecycle.

## Safety and cleanup

Machines are born `isolated: true`, with no networks and SSH disabled. They start
only `sleep infinity`. Before any test workload starts, the probe pins the default
public proxy to port 65535, verifies its `locked` mode, and checks that port has no
listener. With the workload running, a public HTTPS request must return 403, 404,
502 or 503 for both source and clone. It restricts egress and verifies the
provider deletion deadline. The spike contains no real Runner credentials or authenticated service. Boxd's SDK
cannot disable the default public URL; the route remains present but points at a
dead port. Do not bind a private service to that port. #927 tracks a provider-side
disable option. A production adapter needs its own proof with the real image.

The Python workload keeps a fake lease in memory, rereads the kernel hostname,
and wipes that lease and the copied config file when identity changes. It then
waits for config naming the new machine. Nothing connects to Signalbox or a
provider. Live proof checks that the child sees its own hostname, keeps the same
PID, clears the lease, and reconnects once only after fresh config. This verifies
the proposed clone signal and guard sequence. It does not prove native Runner
socket teardown or credential handling; those belong to #914 and phase 3.

The singleton stores JWTs only in its private DO storage. It coalesces concurrent
exchange, refreshes five minutes before expiry, and persists a one-minute cooldown
after an exchange attempt. The Worker's binding-only session RPC never has an HTTP
route. Responses contain no JWT, API key, command output, or upstream error body.
Worker observability is disabled for this stack.

A 30-second alarm watches the fixed deadline, retries cleanup, and sweeps reserved
names for late provider completions until an hour past the deadline. If cleanup
still fails, alarms continue. Provider delete-after timers backstop machine
cleanup; SDK 0.2.17 sets these in a separate call after allocation, so the ownership
record and sweep also cover that gap. Snapshots have no provider TTL. Keep the
Worker and DO deployed until deletion is confirmed. After `/status` says `run.done`,
verify both machines and the snapshot are gone in boxd, then destroy this Alchemy
stage with the same config and stage arguments. Never destroy the stack first.
