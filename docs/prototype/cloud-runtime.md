# Signalbox cloud runtime plan

Research date: 2026-10-01. Repo: T3 Code fork at `t3code-87533d7a` (`origin/main` 53de792f13, `upstream/main` 5a574a77d1).
Cloudflare facts come from docs that changed in the last few days, mostly 2026-09-30. Several APIs are public beta, so recheck them before building.

**Short version:** the T3 server can't run in a Durable Object. It spawns provider CLIs, runs node-pty, shells out to git, and keeps everything under one T3 home on a real filesystem. So the unit you move to the cloud is **the whole T3 server inside one container image**, with a DO in front as gateway, waker and keep-alive. Ship v1 on a VM using that same image. Spike Cloudflare Containers next to it, then move environments across by backup and restore.

---

## 0. What T3 already has (repo evidence)

| Area             | What exists                                                                                                                                                                                                                                                                                                 | Where                                                                                                                                                                |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server runtime   | Node ≥22.16, Effect, `node:sqlite`, `node-pty`, `@anthropic-ai/claude-agent-sdk`, child processes through `effect/unstable/process`                                                                                                                                                                         | `apps/server/package.json`, `apps/server/src/processRunner.ts`                                                                                                       |
| State layout     | **Everything lives under T3 home.** `userdata/state.sqlite` (event log, projections, auth sessions), `userdata/secrets`, `userdata/attachments`, `settings.json`, `environment-id`, plus `worktrees/` next to `userdata`                                                                                    | `apps/server/src/config.ts:136-162`                                                                                                                                  |
| Checkpoints      | Hidden git refs `refs/t3/checkpoints/*` **inside each project repo**, not in a separate store                                                                                                                                                                                                               | `apps/server/src/checkpointing/Utils.ts:4`                                                                                                                           |
| Orchestration    | Event-sourced. Serialized command engine, pure decider, projector, queue-backed reactors doing provider/git I/O. Events, projections and command receipts commit in one SQLite transaction                                                                                                                  | `docs/internals/overview.md`                                                                                                                                         |
| Terminals        | Server-owned PTYs with retained history (5k lines / 8 MiB per terminal); clients attach over the WS                                                                                                                                                                                                         | `docs/internals/terminal-runtime.md`                                                                                                                                 |
| Env auth         | Environment-local pairing becomes scoped sessions (cookie, bearer or DPoP). Short-lived WS tickets. Every RPC declares a scope. **No user model inside an environment**: sessions belong to devices, and threads have no author or ACL                                                                      | `docs/internals/environment-auth.md`, `packages/contracts/src/auth.ts:80-115`                                                                                        |
| Remote           | Same server for every route (LAN, Tailscale, SSH, T3 Connect). Hosted web is a pure client that connects straight to the environment. `t3 service install` runs a systemd user service on Linux                                                                                                             | `docs/internals/remote.md`, `docs/user/background-service.md`                                                                                                        |
| T3 Connect       | Relay is a **Cloudflare Worker** (Alchemy) using PlanetScale Postgres via Hyperdrive, **Clerk** identity (session JWT plus CLI OAuth/PKCE plus device grant), DPoP-bound bootstrap credentials, managed **Cloudflare Tunnels** per environment with a reaper, and APNs/FCM push. It is not in the data path | `infra/relay/*`, `docs/internals/t3-connect.md`, `docs/operations/connect-setup.md`                                                                                  |
| Provider env     | Each provider instance gets its own env vars (for example `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`), plus `homePath`/`CLAUDE_CONFIG_DIR`/`CODEX_HOME` and launch args                                                                                                                                   | `packages/contracts/src/providerInstance.ts:112-128`, `apps/server/src/provider/ProviderInstanceEnvironment.ts`, `docs/user/providers-claude.md` (OpenRouter recipe) |
| Codex auth       | **Managed ChatGPT plan sharing via OpenAI OAuth** (scope `chatgpt.tokens.use.direct`, dynamic client registration). Tokens live in T3's secret store and reach `codex` as env `ACCESS_TOKEN` through a custom `model_provider`. A remote-environment handoff exists                                         | `apps/server/src/provider/CodexManagedRuntime.ts`, `CodexChatGptAuth.ts`, `CodexChatGptHandoff.ts`                                                                   |
| Startup recovery | On restart it reconciles provider sessions; interrupted turns don't resume transparently                                                                                                                                                                                                                    | `apps/server/src/serverRuntimeStartup.ts:481`                                                                                                                        |
| Containers       | No Dockerfile. A devcontainer exists for development only                                                                                                                                                                                                                                                   | `.devcontainer/`, `docs/internals/devcontainer.md`                                                                                                                   |

**Upstream:** I found no hosted or cloud _execution_ environments upstream. "T3 Cloud" was renamed T3 Connect (#3011) and only brokers access to machines you run yourself. Recent upstream "cloud" commits only touch the relay, tunnels and hosted web. Anything Signalbox builds here is fork-owned, so keep it outside `apps/server` orchestration to keep nightly syncs cheap.

---

## 1. T3 components mapped to Cloudflare primitives

Hard constraint: in Workers and DOs, `child_process` and `worker_threads` are **non-functional stubs**, isolate memory is 128 MB, and native addons such as node-pty don't load ([Node compat](https://developers.cloudflare.com/workers/runtime-apis/nodejs/), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)). Containers are Firecracker microVMs (linux/amd64) with **ephemeral disk**. Persistence comes only from snapshots (filesystem only, tied to one image, 30-day TTL, max 20 GB), `DirectoryBackup` to R2 (portable across image versions), S3/R2 mounts (not POSIX, not SSD-like), or DO SQLite ([lifecycle](https://developers.cloudflare.com/containers/platform-details/architecture/), [snapshots](https://developers.cloudflare.com/containers/guides/snapshots/), [Sandbox lifetime](https://developers.cloudflare.com/sandbox/concepts/lifetime/)).

| T3 component                                                                                           | Can it run in a DO?                                                                                                                                                                                             | Cloudflare home                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider adapters (Codex app-server, Claude Agent SDK → `claude`, OpenCode server, cursor-agent, grok) | **No**, needs subprocesses                                                                                                                                                                                      | Container                                                                                                                                                                                                                                                                                                                                          |
| Terminals (node-pty)                                                                                   | **No**                                                                                                                                                                                                          | Container. Sandbox SDK has PTY exec, but T3's own manager inside the container is simpler                                                                                                                                                                                                                                                          |
| Git, worktrees, checkpoint refs, project files                                                         | **No** (real FS plus git binary)                                                                                                                                                                                | Container disk. Durability through `DirectoryBackup` to R2 and `git push`. Later, maybe Cloudflare Artifacts (git-on-DO, open beta 2026-10-01, [blog](https://blog.cloudflare.com/artifacts-git-for-agents-beta/))                                                                                                                                 |
| Event store, projections, auth sessions (`state.sqlite`)                                               | _Technically yes_: DO SQLite gives 10 GB per object, is single-threaded and serialized, which matches the engine. But the engine, reactors and Effect platform layers assume Node, so it's a rewrite (option B) | v1/A: container plus R2 backup. B: DO SQLite                                                                                                                                                                                                                                                                                                       |
| WS/HTTP RPC endpoint                                                                                   | The server, no. A proxy, yes                                                                                                                                                                                    | DO gateway proxies to the container through `ctx.container.getTcpPort().fetch()`. A DO-accepted WS **bridge** is what keeps the container alive; hibernation would drop it ([previews](https://developers.cloudflare.com/sandbox/previews/), [terminal guide](https://developers.cloudflare.com/sandbox/commands/open-a-terminal-in-the-browser/)) |
| Wake, idle and keep-alive lifecycle                                                                    | Yes                                                                                                                                                                                                             | DO alarms. Work running inside the container **does not** keep it alive, so the DO has to heartbeat while turns run ([lifecycle](https://developers.cloudflare.com/containers/platform-details/architecture/))                                                                                                                                     |
| Attachments, browser artifacts                                                                         | n/a                                                                                                                                                                                                             | Container disk in v1, R2 as target (Standard $0.015/GB-mo, free egress, [R2 pricing](https://developers.cloudflare.com/r2/pricing/))                                                                                                                                                                                                               |
| Provider credentials, T3 secrets                                                                       | DO storage or a secrets store can hold them                                                                                                                                                                     | Inject through Container **outbound handlers** (`interceptHttps`) so the agent never sees the token ([outbound traffic](https://developers.cloudflare.com/containers/configuration/outbound-traffic/), [sandbox auth blog](https://blog.cloudflare.com/sandbox-auth/))                                                                             |
| Relay, links, push, identity                                                                           | Already Workers                                                                                                                                                                                                 | Keep `infra/relay` as it is. Add DOs for presence, sharing and automation triggers                                                                                                                                                                                                                                                                 |
| Preview ports                                                                                          | n/a                                                                                                                                                                                                             | Sandbox preview URLs or container hostnames                                                                                                                                                                                                                                                                                                        |
| Desktop-isms (HostPowerMonitor, keyring, Electron)                                                     | n/a                                                                                                                                                                                                             | Turn off in a "cloud host" mode. Secrets must use file storage, not `@napi-rs/keyring`                                                                                                                                                                                                                                                             |

**Container numbers** ([limits](https://developers.cloudflare.com/containers/platform-details/limits/), updated 2026-09-30; [pricing](https://developers.cloudflare.com/containers/pricing/)):

- **Instance ceiling:** the largest is standard-4 at 4 vCPU / 12 GiB / 20 GB disk, and custom types are capped the same way.
- **Pricing:**
  - vCPU: $0.000020/vCPU-s, billed on _active_ use.
  - Memory: $0.0000025/GiB-s, billed on _provisioned_ size.
  - Disk: $0.00000007/GB-s.
  - Egress: $0.025/GB in NA/EU after 1 TB.
- **Cold start:** about 650 ms median, 1.1 s p99 after the 2026-09-30 improvements ([blog](https://blog.cloudflare.com/faster-agent-sandboxes/)). Restoring T3 home from R2 comes on top of that and hasn't been measured.
- **APIs:**
  - GA since 2026-04-13 ([changelog](https://developers.cloudflare.com/changelog/post/2026-04-13-containers-sandbox-ga/)).
  - The native `ctx.container` API and the `durable_object` scheduling policy (which snapshots require) are **public beta from 2026-09-30**.
  - The legacy `Container` class is maintained only until 2026-12-31.
  - Sandbox SDK 1.0 shipped 2026-09-30 ([changelog](https://developers.cloudflare.com/changelog/post/2026-09-30-sandbox-sdk-1-0/)). Build directly on `ctx.container`.

**DO numbers** ([limits](https://developers.cloudflare.com/durable-objects/platform/limits/), [pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [websockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)):

- **Limits:** 10 GB SQLite per object, 2 MB max row, 30 s CPU per request (configurable to 5 min), roughly 1k req/s per object.
- **Pricing:** non-hibernating `accept()` sockets bill duration at 128 MB. That's about 79k GB-s for 8 h × 22 days, inside the 400k GB-s/month included.
- **Deploys:** deploying gateway code disconnects every socket. T3's client runtime already reconnects.

---

## 2. Candidate architectures

### A. Whole T3 server per environment in a Container, fronted by a DO

```
client ──HTTPS/WS──▶ Worker (env-<id>.signalbox.dev) ──▶ EnvGateway DO ──ctx.container──▶ [signalbox-env image: t3 serve + git + codex + claude]
                                                         │  alarms / heartbeat              │ T3 home restored from R2 DirectoryBackup
                                                         └─ R2 (backups, attachments)       └─ outbound handler injects API creds
```

- **How it works:**
  1. On the first request, the DO starts the container, restores T3 home from R2 if the disk is empty, and proxies HTTP and WS.
  2. T3's own pairing and DPoP auth still hold end to end, because the DO is only a proxy.
  3. While clients are connected, the WS bridge keeps the container up. While turns run with no client attached, an alarm polls a small "busy?" endpoint on the T3 server.
  4. When idle, the DO checkpoints SQLite (WAL checkpoint or `VACUUM INTO`), runs `DirectoryBackup`, then lets the container sleep.
- **Cost:**
  - One standard-3 (2 vCPU / 8 GiB / 16 GB) running 8 h/day for 22 days at 30% CPU comes to about **$20/month** (memory $12.5, vCPU $7.2, disk $0.7), plus Workers Paid at $5.
  - Running 24/7 on standard-4 at 20% CPU is about **$120/month**.
  - Scale-to-zero is the win. Always-on costs more than a VM.
- **Cold start:** about 1 s for the VM, plus the R2 restore (it scales with repo and `node_modules` size, still unknown), plus T3 boot and provider reconnect. On eviction, in-flight turns die; startup reconcile handles the bookkeeping but doesn't resume the work.
- **Persistence:**
  - Disk is ephemeral. Snapshots are tied to one image, and T3 updates mean a new image, so **snapshots can't be the durable store**.
  - Use `DirectoryBackup` of T3 home plus the repos to R2. Git remotes are the real source of truth for code.
  - Provider homes (`~/.codex`, `~/.claude`) have to sit inside the backed-up tree.
- **Fan-out and multi-user:** T3 already fans out to multiple clients, so the DO doesn't. Two users can share an environment, but nothing attributes threads to a person.
- **Effort and upstream fit:**
  - New code: a Dockerfile, a gateway Worker+DO, backup/restore, and the lifecycle heartbeat. That's roughly **1–2 weeks to spike, 4–6 weeks to production-quality**.
  - T3 changes: a "cloud host" mode (file secret store, no power monitor), a busy/idle probe, and a pre-backup SQLite checkpoint hook.
  - **Upstream compatibility is high**, because orchestration is untouched.
- **Hard limits:** 20 GB disk, 12 GiB RAM and 4 vCPU per environment. Big monorepos with several worktrees, `node_modules` each, and parallel agents (300–800 MB RSS per CLI plus builds) will hit the ceiling. Bigger instances need the account team.

### B. Re-implement orchestration in DOs, containers only for execution

- **How it works:** the event store and projections move into DO SQLite with WS hibernation fan-out. Containers run per thread or per turn as "execution agents" over RPC (provider process, PTY, git).
- **Pros:** real scale-to-zero, cheap idle, durable state independent of containers, native multi-user and presence, per-thread sandboxes.
- **Cons:**
  - You rewrite T3's most actively changing code (engine, reactors, provider adapters, checkpointing) for the Workers runtime and split it across an RPC seam.
  - Long-lived provider sessions (Codex app-server JSON-RPC, Claude SDK streams) still need containers kept alive, so idle savings only come between turns.
  - Every checkpoint or diff becomes cross-boundary I/O.
  - **Upstream sync stops being practical.**
- **Effort:** 2–4+ months, and the fork diverges for good. Not for v1.

### C. Pragmatic v1: T3 server on a VM, DO for thin coordination only

- **How it works:**
  1. Build the same `signalbox-env` image as A and run it on the existing Dokploy host, one container per user (or one shared), each with a persistent volume for T3 home.
  2. Expose it through cloudflared (Tunnel), or Tailscale plus normal pairing.
  3. DOs, if any, only handle presence, sharing links and automation triggers. Those can reach the VM through Workers VPC (beta; WS support not stated, [docs](https://developers.cloudflare.com/workers-vpc/)) or just through the public tunnel hostname.
- **Pros:** works in **2–4 days**, real disk, no 20 GB cap, nothing beta, zero T3 changes.
- **Cons:**
  - Always-on cost. Hetzner raised CPX/CCX prices 2.4–2.7× in 2026; CCX23 is about €86/month per third-party trackers ([northflank](https://northflank.com/blog/hetzner-cloud-server-price-increases), [wz-it](https://wz-it.com/en/blog/hetzner-price-increase-june-2026-cpx-ccx-alternatives/)). The existing host is a sunk cost.
  - A single box is a single point of failure.
  - No per-environment isolation unless you add containers.
- **Reaching it:**
  - Upstream T3 Connect means signing into pingdotgg's hosted relay and Clerk.
  - Self-hosting `infra/relay` needs a Clerk app (the device grant is beta and enabled on request), PlanetScale, Axiom and a CF zone. That's too heavy for two people right now.
  - A plain Cloudflare Tunnel plus T3 pairing is enough.

### Recommendation

**v1 = C using A's image. Target = A, plus coordination DOs. B stays deferred.**

1. **Week 1:** write the `signalbox-env` Dockerfile (Node 24, git, gh, codex, claude, `t3`). Set `T3CODE_HOME=/data/t3`. Run one container per founder on the Dokploy host with a volume. Expose each through a Cloudflare Tunnel hostname, pair devices with T3 pairing, and have each person sign into their own providers inside their own environment.
2. **Weeks 1–2, in parallel:** spike A on Cloudflare (`ctx.container` with `durable_object` scheduling, gateway DO, R2 `DirectoryBackup`). Measure:
   - cold resume with a real repo
   - backup size and time
   - SQLite integrity across backup and restore
   - WS stability through the DO bridge
   - the disk and RAM ceiling with two parallel agents
   - idle billing
3. **If the spike passes:** move environments VM → Container by restoring T3 home. Same image and same `environment-id`, so the identity carries over. Saved connections are keyed to an endpoint, though, so give each environment a stable `env-<id>` hostname from day 1: the tunnel serves it now and the Worker takes it over later.
4. **Then:** add DOs for cross-environment features (presence, sharing, scheduled automations that wake containers) and a credential vault with outbound injection. Revisit B only if eviction or cold start proves to be the real bottleneck.

---

## 3. Provider auth in the cloud

**Codex**

- **T3 already has the legitimate path:** managed ChatGPT plan sharing through OpenAI's OAuth (`chatgpt.tokens.use.direct`), with tokens kept in T3's secret store, plus a remote-environment handoff (`CodexChatGptHandoff.ts`). This works for a headless cloud environment with no CLI login at all.
- **Alternatives:**
  - `codex login --device-auth` (beta, enable it in ChatGPT security settings first).
  - Copying `~/.codex/auth.json`. OpenAI says not to share one file across concurrent jobs or machines because refresh rotates.
  - API keys for automation.
  - Sources: [auth](https://learn.chatgpt.com/docs/auth), [CI/CD auth](https://learn.chatgpt.com/docs/auth/ci-cd-auth).
- **Leak to verify:** T3 passes the ChatGPT token to `codex` as env `ACCESS_TOKEN`. Codex's `shell_environment_policy.ignore_default_excludes` defaults to **true**, so KEY/SECRET/TOKEN vars are **not** stripped from spawned shells ([config reference](https://learn.chatgpt.com/docs/config-file/config-reference)). A full-access agent can probably `printenv ACCESS_TOKEN`. Check this and add an exclude filter.

**Claude Code**

- **Options:**
  - `claude setup-token` gives a one-year `CLAUDE_CODE_OAUTH_TOKEN`; that token can only make model requests.
  - On Linux, `/login` stores credentials in `~/.claude/.credentials.json`.
  - Precedence: `ANTHROPIC_AUTH_TOKEN` > `ANTHROPIC_API_KEY` > `apiKeyHelper` > `CLAUDE_CODE_OAUTH_TOKEN` ([authentication](https://code.claude.com/docs/en/authentication)).
- **Terms** ([legal & compliance](https://code.claude.com/docs/en/legal-and-compliance)):
  - Hosting the **unmodified** binary is allowed if "each end user must authenticate with their own" subscription or API key.
  - Developers may not "route requests through Free, Pro, or Max plan credentials on behalf of their users" or "collect, store, or intermediate Claude.ai credentials."
  - Enforcement is "without prior notice."
  - Agent SDK docs repeat the "no claude.ai login in third-party products unless approved" rule ([Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview)). T3 uses the Agent SDK, so upstream T3 already sits in this grey zone for personal use.
- **Safe shape:** each founder signs into Claude inside **their own** environment, or uses an API key.

**CLIProxyAPI** ([repo](https://github.com/router-for-me/CLIProxyAPI), [docs](https://help.router-for.me/))

- **What it is:** a Go proxy under MIT, very active (v8.0.8 on 2026-10-01). It exposes OpenAI Chat/Responses, Claude Messages and Gemini APIs on top of OAuth logins (`--codex-login`, `--claude-login`, Gemini/Antigravity, Grok, Kimi) and API keys.
- **Pooling:** credential JSON files go in `auth-dir`. `routing.strategy` is `round-robin`, `weighted-round-robin` or `fill-first`. It retries on 403/408/429/5xx across credentials, with optional session affinity and a cooldown.
- **Access and deployment:** client access uses `access.api-keys`. The management API is off unless `secret-key` is set and is localhost-only by default. Docker image is `eceasy/cli-proxy-api`. It also ships Claude "cloak" and `fingerprint-profile` options to mimic official clients.
- **Pointing T3 at it:**
  - **Claude:** a Claude provider instance with env `ANTHROPIC_BASE_URL=http://proxy:8317`, `ANTHROPIC_AUTH_TOKEN=<proxy key>`, `ANTHROPIC_API_KEY=` (empty). That's the existing OpenRouter recipe ([agent-client/claude-code](https://help.router-for.me/agent-client/claude-code.html)).
  - **Codex:** an "existing" instance whose `config.toml` sets `model_provider="cliproxyapi"` with `base_url=http://proxy:8317/v1`, `wire_api="responses"`, and a bearer token ([agent-client/codex](https://help.router-for.me/agent-client/codex.html)).
- **Verdict: don't pool the two founders' subscriptions.**
  - It breaks OpenAI's and Anthropic's no-account-sharing terms ([Anthropic consumer terms](https://www.anthropic.com/legal/consumer-terms), [OpenAI terms](https://openai.com/policies/row-terms-of-use/)).
  - It is exactly the "intermediating" Anthropic bans and actively detects. Weekly limits since Aug 2025; server-side blocking of non-Claude-Code OAuth reported from Jan 2026, secondary sources only ([paddo.dev](https://paddo.dev/blog/anthropic-walled-garden-crackdown/)).
  - The cloak and fingerprint features tell you this is an adversarial arms race.
  - One proxy holding several refresh tokens is a single high-value target.
  - The only clean use is fronting **API keys** (OpenRouter and similar), and T3's per-instance env vars already do that without a proxy.

**Safety with always-full-access agents**

- In A or C, the agent runs as the **same uid** as the T3 server. It can read `~/.codex/auth.json`, `~/.claude/.credentials.json`, T3's `userdata/secrets` (session signing keys, provider tokens) and env vars.
- **Mitigations, in order:**
  1. One environment per person, so the blast radius is one person's credentials.
  2. A Codex env exclude filter for `ACCESS_TOKEN`.
  3. Container egress allowlist (`allowedHosts`).
  4. For **API keys**, Cloudflare outbound handlers inject the real key after the request leaves the sandbox, while the sandbox holds a placeholder. Cloudflare's coding-agent runner does exactly this with `enableInternet:false` plus a gateway ([runner guide](https://developers.cloudflare.com/sandbox/get-started/build-a-coding-agent-runner/)).
  5. Later: run provider processes as a separate uid from the T3 server. T3 doesn't support this today.
- Injecting _subscription_ OAuth tokens from outside the sandbox is technically the same mechanism, but under Anthropic's wording it counts as storing and intermediating credentials. Avoid it for Claude subscriptions.

---

## 4. Identity

- **T3 today:**
  - Environment auth is self-contained: pairing yields scoped device sessions, with DPoP, WS tickets and per-RPC scopes.
  - No user or org model inside an environment, so nothing records who ran what.
  - T3 Connect adds Clerk-based cloud identity in the relay only (web, desktop, mobile and CLI device grant are all wired up).
- **What two people need now:** nothing new. Each founder gets an environment and pairs their own devices with administrative scopes. Put the tunnel hostnames behind nothing extra, because T3 auth already gates them.
  - Cloudflare Access (free up to 50 users, [Access](https://www.cloudflare.com/sase/products/access/)) on the API/WS origin would break native and mobile pairing unless you use service tokens or bypass rules.
  - Use Access only for admin surfaces (Dokploy, the CLIProxy management API if you ever run it).
- **What the target needs:** one control-plane identity for "who owns which environment, sharing, automations".
  - **Clerk**, if you adopt `infra/relay`. That's zero client work since every surface already speaks it. Hobby is free but has no passkeys or MFA; Pro is $25/month ([pricing](https://clerk.com/pricing)).
  - **WorkOS AuthKit**: free to 1M MAU, with passkeys, MFA, social login, orgs and SSO at $125 per connection ([pricing](https://workos.com/pricing)). Better if you want orgs or enterprise SSO later. Migrating costs you relay token verification plus sign-in flows in web, desktop, mobile and CLI.
  - **Recommendation:** stay on Clerk unless enterprise SSO is a near-term need.

---

## 5. Risks and unknowns

1. **Container ceiling.** 20 GB disk, 12 GiB RAM and 4 vCPU per environment. This could rule A out for large repos. Measure it in the spike.
2. **Durability.** Disk is ephemeral and snapshots are image-bound with a 30-day TTL. Anything not in R2 or git is lost on eviction. The SQLite WAL has to be checkpointed before backup, or you get a corrupt copy (same rule as AGENTS.md's `VACUUM INTO`).
3. **Keep-alive.** The container dies when no DO request, connection or alarm is active, even mid-turn. The heartbeat and busy probe are load-bearing.
4. **Beta churn.** `ctx.container` and `durable_object` scheduling went public beta on 2026-09-30, and the legacy class ends 2026-12-31.
5. **Unmeasured costs.** Restore time and snapshot billing are undocumented. Idle billing under the inactivity timeout is unclear. DO and container may not be co-located, which adds latency.
6. **Workers VPC.** WS support (and so the DO→VM path in C) is unverified.
7. **Provider terms.** Pooling is a ban risk. Even per-user Claude subscriptions through the Agent SDK in a hosted product are grey.
8. **Shared environment.** With no in-environment user identity, a shared environment can't do attribution or per-project ACLs. Per-user environments avoid this for now.
9. **Codex token exposure.** `ACCESS_TOKEN` env is probably exposed to agent shells. Unverified.

## 6. Rough effort

| Piece                                                                                                                         | Effort                                     |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| C v1: image, Dokploy, tunnels, pairing, provider sign-in for 2 users                                                          | 2–4 days                                   |
| A spike: gateway DO, `ctx.container`, R2 backup/restore, heartbeat, measurements                                              | 1–2 weeks                                  |
| A production: provisioning per environment, backup schedule, image upgrade path, outbound credential injection, observability | +3–5 weeks                                 |
| Coordination DOs (presence, sharing, automation triggers)                                                                     | 1–2 weeks each, after A                    |
| B: orchestration in DOs                                                                                                       | 2–4+ months, permanent upstream divergence |

## Sources

- Cloudflare Containers: [limits](https://developers.cloudflare.com/containers/platform-details/limits/), [pricing](https://developers.cloudflare.com/containers/pricing/), [architecture/lifecycle](https://developers.cloudflare.com/containers/platform-details/architecture/), [API](https://developers.cloudflare.com/containers/api/), [snapshots](https://developers.cloudflare.com/containers/guides/snapshots/), [outbound traffic](https://developers.cloudflare.com/containers/configuration/outbound-traffic/), [GA changelog](https://developers.cloudflare.com/changelog/post/2026-04-13-containers-sandbox-ga/), [DO scheduling policy](https://developers.cloudflare.com/changelog/post/2026-09-30-durable-object-scheduling-policy/), [faster agent sandboxes blog](https://blog.cloudflare.com/faster-agent-sandboxes/)
- Sandbox SDK: [overview](https://developers.cloudflare.com/sandbox/), [1.0 changelog](https://developers.cloudflare.com/changelog/post/2026-09-30-sandbox-sdk-1-0/), [lifetime](https://developers.cloudflare.com/sandbox/concepts/lifetime/), [previews](https://developers.cloudflare.com/sandbox/previews/), [browser terminal](https://developers.cloudflare.com/sandbox/commands/open-a-terminal-in-the-browser/), [coding agent runner](https://developers.cloudflare.com/sandbox/get-started/build-a-coding-agent-runner/), [coding agents](https://developers.cloudflare.com/sandbox/coding-agents/), [sandbox auth blog](https://blog.cloudflare.com/sandbox-auth/), [outbound workers changelog](https://developers.cloudflare.com/changelog/post/2026-04-13-sandbox-outbound-workers-tls-auth/)
- Durable Objects: [limits](https://developers.cloudflare.com/durable-objects/platform/limits/), [pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/), [pending I/O keep-alive](https://developers.cloudflare.com/changelog/post/2026-10-01-pending-io-keep-alive/), [Agents SDK](https://developers.cloudflare.com/agents/), [DO facets](https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/)
- Workers, R2, D1, VPC, Artifacts: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Node compat](https://developers.cloudflare.com/workers/runtime-apis/nodejs/), [R2 pricing](https://developers.cloudflare.com/r2/pricing/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [Workers VPC](https://developers.cloudflare.com/workers-vpc/), [Artifacts beta](https://blog.cloudflare.com/artifacts-git-for-agents-beta/), [Access](https://www.cloudflare.com/sase/products/access/)
- Provider auth: [Codex auth](https://learn.chatgpt.com/docs/auth), [Codex CI/CD auth](https://learn.chatgpt.com/docs/auth/ci-cd-auth), [Codex config reference](https://learn.chatgpt.com/docs/config-file/config-reference), [Codex env vars](https://developers.openai.com/codex/environment-variables), [Claude Code authentication](https://code.claude.com/docs/en/authentication), [Claude Code legal & compliance](https://code.claude.com/docs/en/legal-and-compliance), [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview), [Anthropic consumer terms](https://www.anthropic.com/legal/consumer-terms), [OpenAI terms](https://openai.com/policies/row-terms-of-use/), [Anthropic weekly limits](https://x.com/AnthropicAI/status/1949898502688903593), [enforcement (secondary)](https://paddo.dev/blog/anthropic-walled-garden-crackdown/)
- CLIProxyAPI: [repo](https://github.com/router-for-me/CLIProxyAPI), [releases](https://github.com/router-for-me/CLIProxyAPI/releases), [config example](https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/main/config.example.yaml), [docs](https://help.router-for.me/), [auth-dir](https://help.router-for.me/configuration/auth-dir.html), [management API](https://help.router-for.me/management/api.html), [Codex client](https://help.router-for.me/agent-client/codex.html), [Claude Code client](https://help.router-for.me/agent-client/claude-code.html)
- Identity: [WorkOS pricing](https://workos.com/pricing), [WorkOS user management](https://workos.com/user-management), [Clerk pricing](https://clerk.com/pricing)
- VM pricing (third-party): [northflank](https://northflank.com/blog/hetzner-cloud-server-price-increases), [wz-it](https://wz-it.com/en/blog/hetzner-price-increase-june-2026-cpx-ccx-alternatives/), [betterstack](https://betterstack.com/community/guides/web-servers/hetzner-cloud-review/)

**Unverified:** snapshot billing and restore speed; WS through Workers VPC; Anthropic's Jan/Apr 2026 enforcement (secondary sources only); Codex token TTLs; which WorkOS features are on the free tier; Access pricing above 50 seats; whether Codex strips its own `env_key` var from agent shells.
