# Signalbox: from prototype to product

Evidence: inventory.md, upstream-and-releases.md, cloud-runtime.md, features.md (this folder).

## Where we are

- 528 files changed (+46k), all uncommitted, nothing in apps/server. 33 commits behind upstream; a test merge already conflicts in 5 files.
- Real today: branding, rail/shell, Pipeline relabel (Settle→Archive, Remind me later), send-lock latch, header actions, feedback (raw Sentry envelopes), demo tooling, lint rule.
- Mixed (real data + mock bits): Home tree/sections, chat/task kind, composer, New bar, usage.
- Mock only: Appa, multiplayer/rooms/sharing, automations, plugins/skills, spaces, devices/team.
- Live problems: upstream PostHog key ships in our server (usage events go to T3); app ID / ~/.t3 / update feed / ports still T3's; 18 upstream workflows active and stuck in the fork; upstream sync automation paused; mock data leaks into real threads (fake people, hardcoded avatar, Share); ALWAYS_FULL_ACCESS on unsandboxed local runs; real Archive hidden; personal data in fixtures; demo reset can delete any --home-dir; demo seed + console wrapper run for everyone.

## Phase 0: make it ownable and safe (≈3–5 days)

1. Preserve: commit the prototype to a fork branch (private push), scrub personal data first.
2. Repo hygiene: disable upstream workflows in fork settings; resume a fork-side upstream sync (GitHub Action every 3–6h, merge not rebase, issue on conflict) + CI check "fork branch merges cleanly with upstream".
3. Own identity: app ID, data dir (~/.signalbox), port, URL scheme, update repo, PostHog key, npm/bundle names. One-time import from ~/.t3 (copy, never move).
4. Shrink the diff: product name in one module (kills ~80 rename-only files); one hook per hot upstream file (Sidebar, ChatView, ChatComposer, MessagesTimeline, ChatHeader); fork code in its own dirs; regenerate routeTree.gen.ts instead of merging it.
5. Gate the prototype: a "Labs" flag; mock surfaces off by default; no mock data in real threads; restore real Archive in the menu; full-access only where the env is a sandbox (cloud container), picker back locally; demo-only code behind demo env; guard demo reset.

## Phase 1: v1, both founders use it daily (≈2–3 weeks)

- Releases: fork-only release workflow on free macOS runners; self-signed cert; nightly + stable channels on fork releases; desktop updater on fork feed. Same workflow builds the server container image (GHCR) so cloud envs update too.
- Cloud environment: one container per founder (Node, git, codex, claude, Signalbox server) on the Dokploy host, persistent volume, Cloudflare Tunnel, normal pairing; desktop/web/mobile are gateways. Nightly R2 backup of the home dir (SQLite checkpoint first).
- Parallel spike: same image as a Cloudflare Container behind a Durable Object gateway (WS bridge + alarms keep-alive, R2 restore). Pass criteria: cold resume time, backup/restore integrity, disk/RAM ceilings with real repos.
- Feedback: Sentry SDK (browser + Electron) with our own project, release/channel/env tags, user identity, screenshot + server log attachment; drop hand-built envelopes and the global console wrapper.
- Analytics: own PostHog project via existing AnalyticsService + a few fork events (capture used, automation run, feedback sent); opt-out in settings.
- Automation v0 (server module apps/server/src/automation, own file automations.json, own tables via CREATE IF NOT EXISTS, no numbered migrations):
  - Triggers: Sentry internal-integration webhook (HMAC verified, ACK <1s, dedupe by issue id) + polling backfill; cron via Effect Schedule.cron.
  - Action: new thread on a fresh worktree in project X, prompt template from payload, provider/model, full access inside the container, agent opens a draft PR (existing PR reactor links it).
  - Runs: run log keyed by thread; Automations view shows real automations + runs (rest of the mock automation UI stays in Labs). Loop guard: ignore bot-originated events.
  - Worktree bootstrap: v0 replicates the short path (createWorktree → thread.create → turn.start); upstream PR to extract ws.ts bootstrap into a service.
- Cheap UI that ships: rail + views, Home (sections/chat-task kept client-local for now), New bar → real drafts (no Appa routing yet), send lock, Pipeline relabels, header actions, branding.
- CLIProxyAPI: Claude via instance env (ANTHROPIC_BASE_URL/AUTH_TOKEN); Codex as a third setupMode copied from CodexManagedRuntime; Usage page reads CPA management API (accounts, pause/resume, login, header-based 5h/weekly windows). Pools/sharing/advice stay mock. ToS decision below.

## Phase 2: working together

Clerk identity across clients; shared projects/threads between two environments or a shared team env with per-user attribution; real sharing (default scopes, deviations), presence, @mentions, wait-for; rooms; device-aware notifications. Server persistence for sections and chat/task kind.

## Phase 3: Appa and supervisors

Supervisor runtime (coordinates, never executes, read-only lookups, traceable delegation cards), daily reset, section/project/workflow agents with SOUL/AGENTS, notification policy.

## Phase 4: workflow engine proper

TS-source automations with derived graph, hooks + inline interceptors + steps, more triggers (GitHub, Linear, Slack, Gmail via Executor), marketplace.

## Phase 5: the rest of the surface

Plugins (Executor connections, groups, skills.sh, per-role AGENTS.md), Spaces knowledge base, Devices/computers fleet, account-pool sharing and usage advice (needs our own persistence of CPA usage).

## Phase 6: cloud target

DO-fronted Cloudflare Containers, scale-to-zero, hosted paid tier; revisit moving orchestration state into DOs only if it stops tracking upstream being a cost.

## Decisions and notes (2026-10-02)

- Repo: public `JustYannicc/signalbox`. This branch (`prototype`) stays as the visual reference; real work lands on `main` through PRs.
- First PR: full T3 Code → Signalbox branding plus the setup needed to file PRs. Next: Yannic adapts AGENTS.md himself (keep the "how to think" style, add our principles). Then the sign-up flow, walked through as a new user.
- Analytics: keep sending T3's PostHog events (fine to contribute) and also send the same events to our own PostHog project.
- Not important now: updates should be automatic everywhere. If clients are only clients and servers auto-drain and move work, server and client updates can be fully automatic.
- Idea: the input field can expand to a full page, like a real text editor, for a better overview of long prompts.
