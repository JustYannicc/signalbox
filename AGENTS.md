# Signalbox

Signalbox is one app for working with AI. You start a thread, say what you want, and agents do the work on a server and tell you when they need you. It is meant for knowledge workers as much as for developers.

Signalbox is built on [T3 Code](https://github.com/pingdotgg/t3code). T3 Code gets a lot right, and we want to keep receiving its updates. See [Staying on T3 Code](#staying-on-t3-code).

Explicit user instructions take precedence over these defaults and skill guidance. Continue authorized work without inventing approval gates. If an instruction blocks work, identify its file and exact rule, explain the conflict, and state what remains unfinished.

## What makes Signalbox special?

No single feature. It is many small decisions that together make working with AI feel right. Above all, never compromise the product. Proton set out to do mail, but private. For a normal user the mail matters more than the privacy, and Proton let privacy cost it basic mail features. It forgot the problem it was solving. Know which problem a feature solves, and never let a secondary value break it. These are the things we never trade away.

### 1. Dead simple

Everything is one click. Connecting a provider, adding a second Gmail account, sharing a thread. T3 Code is great, and even we barely used it because it needs setup. If a feature needs a tutorial, a config file, or a terminal, it is not done.

### 2. The cloud runs everything

Work runs on a server; clients are only gateways. Logging in feels like Notion or Google: everything is already there, on every device. The server can be self-hosted, but nothing runs on the client.

### 3. Push, not pull

Today people pull work and hand it to an agent. Signalbox moves to push: agents do the work and tell you when they need you. Attention is the scarce resource, so every notification, badge, and status has to earn it.

### 4. Nobody has to understand it, anyone can dig in

If the user has to understand the complexity, we failed. The average user never looks under the hood. When something goes wrong, the power user wants to, so every action stays observable and traceable down to the exact message one agent sent another. The assistant coordinates and never executes, which keeps that trail readable.

### 5. Every agent represents someone

Most of AI never settled who an agent works for, which is why everyone runs their own agents on their own machine. In Signalbox it is explicit. Your assistant represents you. An agent building a feature represents its project. A workflow's supervisor represents you for a personal workflow and the company for a company one. When you design anything agents touch, decide whose interests the agent serves and how that shapes its design.

### 6. Works with everything until you need nothing else

The goal is one app. Until it is good enough, it plugs into what people already use every day. Meta's display glasses made you adopt their whole ecosystem instead of showing your Google Maps and your phone's notifications, and that's why Yannic didn't buy them. Nobody adopts Signalbox wholesale. Everything connects outward, and nothing locks you in.

### 7. One interface, wherever you are

Signalbox follows the person, not the job. Work, personal life, a new employer: it stays the same app, and a new context is something you connect, never something you install. When you design a feature, picture one person bringing several contexts into it at once.

### 8. Opinionated defaults, full freedom

Ship defaults that prevent the avoidable fuckups, so people never have to care about the machinery. Then let them change anything. Tighter guardrails leave less room to do useful work.

### 9. How it feels is how it works

Presentation matters as much as mechanics. The same system with a different label, entry point, or flow changes how people use it. OpenAI renaming live voice to calls is the kind of change we care about. Copy, motion, and layout are part of the feature.

### 10. Better together

One person gets full value alone. Each extra person adds more: multiplayer threads, shared workflows, assistants that talk to each other. Build features so they work solo and get better with a team.

### 11. Hosting is the convenience

Everything works self-hosted. The hosted service adds convenience: no servers to keep running and scaling, and one-click setup for everything. Connecting Gmail is one click because the service provides the Google credentials; self-hosted, you bring your own. Same product either way, one is just less work.

### 12. Fast and everywhere

Inherited from T3 Code. Performance is a feature: watch websocket payloads, GPU-heavy CSS, and long lists. Web, desktop (Electron), and mobile (React Native) all ship every feature where reasonable.

## A note from Yannic

I like ambitious ideas, simple systems, and software that feels obvious. Don't preserve complexity just because it already exists, and don't add machinery because it looks impressive. Understand the real constraint, then fight for the smallest model that makes the correct behavior unsurprising. Measure twice, cut once, and YAGNI. Fight scope creep.

We are building Photoshop, not Canva. Canva feels restrictive. Photoshop trusts the user, and its complexity scares people off. A well-designed system does both: the floor is low enough that anyone starts in a minute, and there is no ceiling. That balance is hard, and it is the job.

AI is a force multiplier. It amplifies whatever you give it, a well-designed system to the extreme, and a mess just as much. So every system has to be well designed, at every level, technical or not. When a system is designed well, it fades away. You stop noticing the complexity you're working with.

Most of this has been figured out somewhere. Before designing anything, look at how others solved it, take the best parts, and combine them. The quick capture is Todoist's, and that's fine. The combination is what makes Signalbox good.

Two interaction models I don't want. The first is the department bot: a university chatbot, a company's accounting agent, Grokbot's roster of bots. Grokbot made AI dead simple to start, and that was a real step for most people. But it doesn't remove the complexity. You still pay the supervisor tax of picking the right bot and managing it. People want to go to the one assistant they already use and have it handle everything from there. The second is the void: OpenClaw started as a CLI, and its front ends still feel bolted on. I tell it something and trust the void to handle it. That trust is the goal. But when something breaks, I need to see what happened. T3 Code's site shows you the app immediately. That difference is felt before anything else.

## Staying on T3 Code

`origin` is `JustYannicc/signalbox`; `upstream` is `pingdotgg/t3code`. Upstream ships hundreds of commits a week, so every fork change is a future merge.

- Merge upstream into `main`; never rebase shared history.
- Rename what users see, type, or install. Keep upstream's internal names (`@t3tools/*`, `T3CODE_*`, symbols, `t3.json`) so upstream patches apply cleanly.
- Put fork features in their own modules. Give an upstream file at most a hook line, using existing seams (routes, provider registries, settings sections) before adding new ones.
- Generic fixes and seams belong upstream. Open those as PRs to T3 Code instead of carrying them.
- Persistence migrations are numbered and the runner only applies ids above the latest recorded one. A fork migration that takes a number upstream later uses silently skips upstream's. Fork tables create themselves (`CREATE TABLE IF NOT EXISTS`) instead.
- `settings.json` decodes through the contracts schema and drops unknown keys on write. Fork settings live in their own file.

## A small glossary

We need to be on the same page with terminology. When communicating, use this language:

- **you** means the agent reading this file and changing Signalbox.
- **we, us** means Yannic. This is who you are talking to now.
- **user** means a person using Signalbox.
- **agent** means an AI agent doing work inside Signalbox. Depending on context, that may also include you.
- **assistant** means a user's personal coordinator. It delegates and never executes.
- **provider** means the agent runtime Signalbox talks to, such as Codex, Claude, Cursor, or OpenCode.
- **client** means the web, desktop, or mobile app. Clients are gateways; they hold no work.
- **environment** means one running server and the machine, filesystem, provider credentials, and state it owns.
- **project** means an environment-local workspace record rooted at a directory.
- **thread** means the durable conversation and work history. A thread shows as a chat or a task; the difference is display only.
- **turn** means one user-to-agent cycle, including follow-up work such as checkpointing.
- **Signalbox home** means the base data directory. Runtime state normally lives below its userdata directory.

The rest of this document helps you navigate the codebase. Treat it as good defaults, not hard rules; the developer's preferences override anything here.

Most Signalbox contributions come from Signalbox itself, often controlled remotely. Be careful about accessing data, killing dev servers, and anything else that could damage the instance the contributor is using.

## The three ways to hurt yourself

1. **Killing by pattern.** Never `pkill -f`, `pgrep | kill`, or `kill` a PID you found by matching a name, path, or worktree string. Your own agent process has this worktree's path in its argv, and this machine runs several other dev servers at once. Kill only a PID you captured at spawn, or the owner of your port from `ss -H -ltnp` after confirming `/proc/<pid>/cwd` is your worktree.
2. **Writing to the live install.** `~/.signalbox/userdata` is the developer's real Signalbox database, in use while you work. `~/.t3/userdata` is T3 Code's, if it is installed alongside; treat it the same way. Reading it and copying from it are fine, and a good way to get real test data (see Test data). Never start a server against it, never open it read-write, never clean it up.
3. **Baking in origins.** Never set `VITE_HTTP_URL` or `VITE_WS_URL` for dev. Dev is single-origin and Vite proxies `/api`, `/ws`, `/oauth`, and `/.well-known`. Setting them bakes localhost into the bundle and silently breaks every remote browser.

## Hit every surface

The most common defect in this repo is a change that works on the path you tested and is missing everywhere else. Before calling frontend work done, walk this list and say which entries applied:

- **Entry points.** A behavior reachable from the chat view is usually also reachable from Settings, the command palette, and a keybinding. Fixing one is not fixing the feature.
- **Clients.** Web, desktop (wraps web, adds Electron shell/IPC), and mobile (React Native, separate navigation). Shared logic lives in `packages/client-runtime`
- **Providers.** Codex, Claude, Cursor, Grok, OpenCode, and Antigravity each have an adapter. Provider-shaped features need a decision per adapter, even if the decision is "not supported here".
- **Agents.** A capability a user can trigger is usually one an agent should reach through MCP tools, and scheduled tasks run the same paths. That only works when it is a service method, not handler code.
- **Contracts.** Anything crossing the wire is typed in `packages/contracts`. Change the schema and the server, web, mobile, and desktop all follow.
- **Reverse states.** If you added a way in, add the way out and the way to see it. Snooze needs unsnooze. Close needs reopen. A one-way door is a bug.
- **Connection modes.** Local, remote/relay, and tunnel behave differently. Multi-device and multi-environment cases are real.
- **Docs.** Check whether the change makes existing guidance inaccurate. Apply the [documentation rules](#documentation) before adding anything.

## Dev servers

- `vp i` installs. Worktrees get this from the t3.json setup script; if module resolution looks broken, it probably did not run.
- `vp run dev` starts server and web. In a worktree, state defaults to that worktree's gitignored `.t3`, which deliberately outranks an ambient `T3CODE_HOME` so you cannot land on shared state by accident. An explicit `--home-dir` still wins.
- Ports derive from the worktree path and are stable across restarts, but read the real ones from the `[dev-runner]` line since occupied ports shift.
- Sharing over the tailnet is three steps: run `vp run dev --share` in the background, wait for the `pairingUrl:` line in its output, then give that full URL to an unpaired browser. Do not wire up `tailscale serve` by hand, open the URL yourself, or consume the user's pairing link. A browser with the reusable dev cookie can use the bare origin. If a normal one-time token was consumed, mint a fresh one with `node apps/server/src/bin.ts pair`. It carries standard scopes, while the startup URL carries admin scopes needed for Connections settings.
- To reuse web dev auth across worktrees, configure one fixed `T3CODE_DEV_AUTH_TOKEN` in the main checkout's gitignored `.env`. The `t3.json` setup links that file into worktrees. Never commit or publish the token or a startup URL. See [Reusable dev credential](docs/operations/development.md#reusable-dev-credential).
- Stop what you started, by the PID you tracked. See rule 1.

## Test data

An empty database is a bad test. Seed your worktree's `.t3` with a copy of real data instead of pointing at live state:

- Run `vp run migrate-dev-db` with your dev server stopped. It rebuilds `<worktree>/.t3/userdata/statev2.sqlite` from a read-only snapshot of `~/.signalbox/userdata/statev2.sqlite`, the developer's real data. It keeps recent projects and their stopped threads, and drops scheduled tasks, pending work, and auth sessions, so your dev server never runs the developer's agents. Raise `--projects` and `--threads-per-project` for more data. Point `--source` at another database file (`~/.signalbox/dev/userdata/statev2.sqlite`, or T3 Code's `~/.t3/userdata/statev2.sqlite`, which uses the same format) when you need it.
- Refresh `statev2.sqlite`, not `state.sqlite`. The server copies the V1 `state.sqlite` only when `statev2.sqlite` is missing.
- Bring `secrets` and `settings.json` only if the flow under test needs them.
- Copy in, never symlink. Data flows one way: into your sandbox, never back out.

## Verifying

- Smallest proof that the change works. `vp test run <files>` for the tests you touched, targeted lint and typecheck for the scope you changed.
- Test meaningful logic or observable behavior. Do not render components to static markup to assert props or attributes, or add tests that merely assert callback wiring or mirror the implementation.
- **Do not run repo-wide checks.** No `vp check`, no `vp run -r test`, no `vp run -r typecheck` unless I ask. CI owns the full suite.
- Backend behavior changes ship with focused tests for that behavior.
- The server is event-sourced, and side effects run after the command commits. In tests, drain the effect worker (`OrchestrationEffectWorkerV2.drain`) or await the specific persisted event or `Deferred` that marks the milestone. Never wait on sleeps or polling. A test that needs a timeout to pass is wrong.
- Upon request, user-visible frontend changes should get one integrated pass in a real client: `test-t3-app` for web, `test-t3-mobile` for mobile. The primary agent does this once after integrating. Subagents do not launch their own dev servers. Ask permission before doing computer use or spinning up browsers.

For authorized mobile verification, a missing or outdated native client is a build step, not a blocker. Run `node scripts/mobile-native-client.ts ensure <ios|android> <device-id>` on the simulator host before starting Metro. It checks the local Expo fingerprint and builds/installs when needed. See `test-t3-mobile` for the full workflow.

## Pull requests

- Never make a PR unless the developer explicitly asks you to do so.
- Conventional commit titles, plain language: `fix(web): new threads no longer spike CPU`.
- Body: the problem in a sentence or two, then how you fixed it. End with the model and harness that did the work.
- UI changes need before/after images. Motion or timing needs a short video.
- Upload PR evidence to GitHub. Never commit PR-only screenshots or assets such as `.github/pr-assets/`.
- One concern per PR. If the description says "also", split it.
- When babysitting: poll checks and comments newer than the last push, verify each bot finding against the source, fix real ones, dismiss false positives with a written reason. Stay quiet when nothing is new. Stop when the bots are green on the latest commit.

## Documentation

Most code changes do not need an internal documentation change. Agents can read the code.

- `docs/internals/` is for architectural decisions and their reasons, constraints that span components, and implementation traps that are hard to discover from the source. Before adding a paragraph, ask what a maintainer would get wrong without it. If reading the relevant code answers the question, leave it out.
- Do not document every feature, enumerate fields or methods, narrate control flow, maintain file catalogs, or append PR summaries. Types, tests, and code already record the implementation. The glossary defines shared vocabulary; it is not a feature index.
- Keep a local implementation explanation in a nearby code comment. Use an internal doc when the reasoning crosses boundaries or needs context the code cannot carry well. Link to the relevant source instead of copying it.
- When a documented decision or constraint changes, rewrite or remove the affected text. Do not append another account of the new behavior. A new internal page needs a distinct, durable reason to exist.
- `docs/user/` helps users accomplish tasks. Give each major feature a concise section explaining what it does, how to start, and anything unintuitive. A settings path is useful; descriptions of visible buttons, icons, layouts, animations, or every UI state are not. Before adding text, ask what task or decision it helps the user with.
- Keep user docs in the shipped product's voice, without implementation details or contributor tooling. Update the relevant feature section when how to use it changes. A UI tweak does not need a documentation entry, and a new control does not need its own page.
- `docs/operations/` holds maintainer setup, release, and debugging procedures. Keep instructions for operating an installed Signalbox server in the user guides.

## Plans and work artifacts

- Do not commit implementation plans, research notes, or agent scratch files. Keep temporary working material outside the worktree. `.plans/` is gitignored only as a safety net for legacy tooling.
- Track active maintainer work in the GitHub issue or project item that owns it. External proposals follow `CONTRIBUTING.md` and belong in Ideas discussions.
- A merged PR is the implementation record. Close or update its tracking item when the work lands; do not preserve a second checklist in the repository.

## How it works

Clients send typed WebSocket requests. The server turns them into _commands_. The _orchestrator_ (`apps/server/src/orchestration-v2/Orchestrator.ts`) serializes commands and decides _events_ without doing any I/O. The _event sink_ commits those events, the _projections_ the UI reads, the _command receipt_, and _outbox_ effects in one transaction. The _effect worker_ then runs the effects, such as starting a provider turn or capturing a checkpoint, and feeds results back as commands. Provider CLIs run as subprocesses; per-provider _adapters_ translate their native protocols into orchestration events. Each turn ends with a _checkpoint_, a hidden git ref, so the app can diff and restore.

Architecture and its constraints: `docs/internals/overview.md`. Glossary: `docs/internals/glossary.md`

## Where code lives

- `apps/server` - WebSocket, orchestration, providers, checkpointing. Effect-heavy: read [Effect services](docs/internals/effect-services.md) before adding server code, and `.repos/effect-smol/LLMS.md` for the Effect library itself.
- `apps/web` - React/Vite UI. `apps/desktop` wraps it, `apps/mobile` is React Native, `apps/marketing` is the site.
- `packages/contracts` - Effect/Schema contracts plus small derived helpers. No heavy runtime logic.
- `packages/shared` - shared runtime utils, subpath exports, no barrel.
- `packages/client-runtime` - client code shared by web and mobile.
- `.repos/` - vendored read-only references. Prefer their patterns over invented ones. Never edit or import from them. Sync with `vpr sync:repos` when bumping the matching dependency.

## Taste

- Complexity belongs at the adapter boundary. Orchestration stays pure, UI stays dumb.
- Server features are services; transports stay thin. A `ws.ts` RPC handler, HTTP route, or MCP tool decodes input, calls one service method, and maps errors. See [Effect services](docs/internals/effect-services.md).
- `apps/web/src/components/ui` exports own their look. Pick a `variant` or `size`; do not restyle one with `className`. If none fits and the look is a generic concept, add a variant to the component; a look that belongs to one feature stays in that feature's own component, not in `components/ui`. Layout classes (width, flex, margin, position) belong on the parent. `shadcn/no-restyle` fails lint on violations.
- Inferred types over annotations. `any` is the enemy.
- Comments describe how a thing is used, and move when the code moves. To be used mostly to describe functions, not to annotate every line of behavior.
- Our users drive agents all day and notice a dropped frame, a lying spinner, and a stale label. No continuously repainting animations; they peg the GPU on high-refresh displays.
- If a rule here fights the task in front of you, say so loudly and get a human sign-off before breaking it.

## Additional tips

- Don't verify with browsers or computer use unless the user explicitly agrees or requests it.
- Security is important, but should not be over-indexed on, especially for dev mode/maintainer-only features.
