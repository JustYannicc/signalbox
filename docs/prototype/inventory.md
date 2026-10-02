# Signalbox prototype inventory

Worktree: `<worktree>` (branch t3code/codex-style-sidebar, all changes uncommitted)

## Base

- HEAD = merge-base(HEAD, origin/main) = origin/main = `53de792f1363a6f92fad9c6cf64f3a57574cc97a` (0 behind origin/main).
- upstream/main = `a3fb5392e361f6a6160cb4a6996284dbf9c1d1b3`; base is **33 commits behind upstream/main** (origin/main itself is 33 behind; fork sync hasn't run since).
- Diff = base -> working tree incl. untracked: **528 files** (185 modified, 343 untracked), **+46,013 / -649** lines. Modified (upstream-owned) files: +1,308/-649. Untracked (fork-new): +44,705.
- No changes to apps/server, docs/, or AGENTS.md (already committed at HEAD). Contracts: only packages/contracts/src/keybindings.ts (+2) and packages/shared/src/keybindings.ts (+1).
- `routeTree.gen.ts` +357 is generated (17 new routes); counted under app shell.

## Summary

| Area                                                  | Files (upstream-owned / fork-new) | +/-        | Upstream-owned lines | Reality                             | Backend needed                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------- | --------------------------------- | ---------- | -------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q lint rule                                           | 4 (2 / 2)                         | +147/-0    | +3/-0                | (a) real                            | none                                                                                                                                                                                                                                                                                                              |
| P demo dataset/tooling                                | 7 (1 / 6)                         | +2869/-0   | +1/-0                | (a) real tooling                    | none                                                                                                                                                                                                                                                                                                              |
| N feedback (Sentry)                                   | 10 (3 / 7)                        | +648/-0    | +11/-0               | (a) real (when DSN set)             | External: Sentry project + VITE_T3CODE_FEEDBACK_DSN at build time.                                                                                                                                                                                                                                                |
| O header actions                                      | 3 (1 / 2)                         | +249/-6    | +14/-6               | (c) mixed                           | Project binding for non-thread surfaces (shared chats, assistant, rooms) once those are real threads.                                                                                                                                                                                                             |
| I automations                                         | 50 (0 / 50)                       | +6802/-0   | +0/-0                | (b) mock                            | Workflow engine (TS workflow source -> graph), triggers/hooks (schedule, inline hooks with latency), run persistence & run chat read model, approvals, review loops, scheduler; workflow-agent supervisor.                                                                                                        |
| J plugins/skills/marketplace                          | 41 (0 / 41)                       | +5890/-0   | +0/-0                | (b) mock                            | Executor integration (connections, OAuth, MCP/API sources, health), access groups model, skills.sh install/publish + versioning, per-harness plugin marketplaces (Codex/Claude), AGENTS.md block compiler per role/scope/harness, team/project defaults presets.                                                  |
| K spaces/PRs                                          | 23 (0 / 23)                       | +3888/-0   | +0/-0                | (b) mock (PR link real)             | Executor-brokered source sync (Drive/Notion/GitHub/Slack/Jira), per-section spaces, agent-facing file projection (/spaces/<path>), native notes persistence + backlinks + sharing.                                                                                                                                |
| L usage/account pools                                 | 13 (1 / 12)                       | +1166/-1   | +2/-1                | (c) mixed                           | Account pooling service (CLIProxyAPI or similar): pooled subscription accounts per harness, exit-server pins, weekly windows/banked resets, pool sharing ACLs; real burn-rate data for advice.                                                                                                                    |
| M devices/computers/team/setup                        | 37 (1 / 36)                       | +3321/-0   | +12/-0               | (b) mock                            | Devices: fleet/server registry, rolling updates/drain, client gateway capabilities. Computers: VM/desktop provisioning, streaming, billing. Team: orgs, invites, members, company agents (Clerk/WorkOS-type). Setup: CLI + MCP server + skill that don't exist yet.                                               |
| G assistant (Appa)                                    | 46 (0 / 46)                       | +5422/-0   | +0/-0                | (b) mock                            | Assistant/supervisor agent runtime (new thread kind + orchestration), delegation/hand-off events & trace read model, daily-reset conversation, notification policy engine + push routing, per-user settings for identity/avatar/SOUL/USER/AGENTS.md (server-side), realtime voice for call page.                  |
| H multiplayer/sharing/rooms                           | 51 (2 / 49)                       | +6205/-4   | +32/-4               | (b) mock, leaking into real threads | Multi-user identity & org membership (beyond single-owner auth), per-item ACLs/sharing persisted server-side, presence, @mention notifications, shared threads with multiple human authors in contracts/orchestration, message author on user turns, assistant-to-assistant rooms with policy enforcement, forks. |
| F capture / New bar                                   | 16 (0 / 16)                       | +1820/-0   | +0/-0                | (c) mixed                           | Capture inbox/routing (where a capture goes, assistant hand-off), capture history, other-device capture (phone/watch/etc.), file upload for captures.                                                                                                                                                             |
| E composer (send lock, full access, mock composer)    | 22 (13 / 9)                       | +1119/-55  | +256/-55             | (c) mixed                           | Send lock: none (client localStorage, real). Full access: none, but it's a policy decision. Mock composer: needs server threads for assistant/agents/rooms/team chats.                                                                                                                                            |
| D pipeline relabel (Settle->Archive, Snooze->Later)   | 11 (11 / 0)                       | +162/-167  | +162/-167            | (a) real                            | none (labels only) - but see behavior change below                                                                                                                                                                                                                                                                |
| C home tree/sections/chat-task kinds                  | 32 (0 / 32)                       | +4506/-0   | +0/-0                | (c) mixed                           | Server-persisted sections/containers + item placement + per-user archive/hide; thread kind (chat/task) on thread; loose (project-less) chats -> upstream #13612 'threads without a project' (scratch project) is now available upstream; team threads need multiplayer backend.                                   |
| B app shell (rail, views, titlebar, settings nav)     | 19 (9 / 10)                       | +1410/-157 | +509/-157            | (c) mixed                           | Rail/views are real UI; views they open are mostly mock. '/' now redirects to /assistant (mock).                                                                                                                                                                                                                  |
| A branding (Signalbox name/icons; desktop+mobile+web) | 143 (141 / 2)                     | +389/-259  | +306/-259            | (a) real                            | none                                                                                                                                                                                                                                                                                                              |

## Upstream hot-file conflict surface (working tree vs base)

| File                                                                                   | Ours +/-       | What                                                                    | Upstream changed since base?                                       |
| -------------------------------------------------------------------------------------- | -------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------ |
| apps/web/src/components/Sidebar.tsx                                                    | +62/-115       | relabels, status refactor to threadStatusDisplay, showChromeHeader prop | no                                                                 |
| apps/web/src/components/ChatView.tsx                                                   | +61/-19        | full-access policy, send-lock guard, timeline annotations, relabels     | no                                                                 |
| apps/web/src/components/chat/ChatComposer.tsx                                          | +63/-2         | send lock, @people mentions, access picker removal                      | **yes (+33/-3)**                                                   |
| apps/web/src/components/sidebar/SidebarChrome.tsx                                      | +74/-35        | rail layout header, Signalbox logo, brand -> /assistant                 | no                                                                 |
| apps/web/src/components/AppSidebarLayout.tsx                                           | +38/-17        | SidebarViews, QuickCaptureHost, history buttons, demo seed              | no                                                                 |
| apps/web/src/routes/_chat.index.tsx                                                    | +18/-100       | "/" -> /assistant redirect, removes draft landing                       | no                                                                 |
| apps/web/src/components/chat/ComposerPrimaryActions.tsx                                | +38/-14        | send-lock latch                                                         | no                                                                 |
| apps/web/src/components/chat/MessagesTimeline.tsx                                      | +23/-4         | annotations slots                                                       | no                                                                 |
| apps/web/src/components/chat/CompactComposerControlsMenu.tsx                           | +20/-14        | hide access radio                                                       | no                                                                 |
| apps/web/src/components/chat/ComposerCommandMenu.tsx                                   | +12/-1         | person item type                                                        | **yes (+22/-1)**                                                   |
| apps/web/src/components/ComposerPromptEditorTiptap.tsx / ComposerPromptEditor.tsx      | +10/-0, +15/-2 | mention renderer context                                                | **Tiptap yes (+25/-1)**                                            |
| apps/web/src/components/CommandPalette.tsx                                             | +12/-0         | Open setup                                                              | **yes (+479/-52)**                                                 |
| apps/web/src/components/threadActionMenu.logic.ts                                      | +21/-13        | relabel + hides server archive                                          | no                                                                 |
| apps/web/src/components/settings/KeybindingsSettings.logic.ts                          | +9/-1          | usage sort fix                                                          | **yes - upstream fixed same bug; drop ours**                       |
| apps/web/src/components/chat/ChatHeader.tsx                                            | +9/-0          | LocalThreadAccessBar                                                    | no                                                                 |
| apps/web/src/routes/_chat.tsx                                                          | +2/-1          | branding                                                                | **yes (+16/-0)**                                                   |
| apps/web/src/hooks/useThreadActions.ts                                                 | +2/-2          | relabel                                                                 | **yes (+11/-4)**                                                   |
| packages/contracts/src/keybindings.ts / packages/shared/src/keybindings.ts             | +2 / +1        | composer.toggleSendLock, capture.open                                   | **yes (+1 each: chat.newWithoutProject) - adjacent-line conflict** |
| apps/mobile/app.config.ts, Stack.tsx, remoteRegistration.ts, widgets/AgentActivity.tsx | branding       |                                                                         | **yes (Expo SDK 58 etc.)**                                         |
| apps/web/package.json, pnpm-lock.yaml                                                  | +1, +8         | modern-screenshot                                                       | **yes (lockfile +1748/-3042)**                                     |
| apps/server/**                                                                         | 0              | -                                                                       | -                                                                  |

Relevant upstream since base: `6b286ae8a2 feat: start threads without a project (#13612)` adds a server-side scratch project + `chat.newWithoutProject` - a real backend for Home's loose "Chats" that the prototype currently fakes.

## Risks / flags

1. **ALWAYS_FULL_ACCESS = true** (apps/web/src/lib/fullAccessPolicy.ts): every real thread silently runs full-access on its next send and the access picker is gone. Comment assumes sandboxed durable objects; that's not how runs execute today. Biggest behavior risk.
2. **"/" redirects to the mock /assistant page**; upstream's draft landing/NoProjectsHero path is deleted from _chat.index.tsx (FirstRunGate still handles first run).
3. **Fixture data leaks into real threads**: ChatHeader access bar (fixture teammates, Share), timeline annotations (hardcoded "Yannic" avatar on every user turn, thread's current model on every assistant turn), composer `@` lists fixture people/agents, Home bell count includes fixtures.
4. **Server archive unreachable**: threadActionMenu drops the real "Archive thread" when settlement is supported; three overlapping "archive" concepts (server archive, settle-as-Archive, Home local archive-for-me).
5. **Demo identity is invented**: fixtures use invented people (Flynn, Samir, Leona, Nora, Kira), an invented employer (Northwind, `northwind.example`), and `.example` email domains. Personal workflows (card bill, monthly expenses, water plants) carry no real amounts or merchants. The section placement heuristic keys on "northwind" in project names. Keep new fixtures invented.
6. **demo-environment.ts `--reset`** rm -rf's any `--home-dir` with no guard (AGENTS.md rule 2: never touch ~/.t3/userdata).
7. **Demo/debug in production path**: useDemoUnreadSeed mounted for everyone; feedbackLogs globally wraps console.warn/error; Sentry DSN baked into bundle from symlinked .env.
8. No secrets found (no API keys/tokens/private keys in new files). No `console.log`/`debugger` in app code (only in the demo CLI script). One TODO (useProjectInFocus.ts).
9. localStorage keys introduced (t3code:composer-send-lock:v1, section store, thread kind, focus, visibility, item access, capture draft, assistant identity/avatar/soul/notification policy) - migration path needed if these move server-side.
10. Branding is literal string edits in ~141 upstream-owned files - recurring sync conflicts; mobile files already conflict with upstream.

## Tests

New: no-effect-expression-body.test.ts, demo-dataset.test.ts, feedbackEnvelope.test.ts, avatarConfig.test.ts, avatarGeometry.test.ts, mentions.test.ts, teamTimeline.test.ts, captureTokens.test.ts, composerSendLockStore.test.ts. Modified: composer-logic.test.ts (+25), useHandleNewThread.test.ts (full-access expectation), threadActionMenu.logic.test.ts (+22/-4); 15 others are branding string updates. No tests for Home tree model, sectionStore, threadKind heuristic, Focus, automations/plugins/spaces models. Not run (read-only task).

## Docs

No docs/ changes. Only assets/README.md (+3/-3, icon export notes). User docs (docs/user) still describe Settle/Snooze/T3 Code; would need updating with the relabel and new surfaces.

## Q lint rule

- Files: 4 (2 upstream-owned, 2 fork-new); +147/-0
- Reality: **(a) real**
- Backend needed: none

New oxlint rule t3code/no-effect-expression-body (expression-bodied effect callbacks leaking return values as cleanup), enabled as 'error' repo-wide in vite.config.ts. Upstream-worthy; also a sync risk if upstream code violates it (untested here - no repo-wide lint run).

| Status             | +/-    | File                                                         |
| ------------------ | ------ | ------------------------------------------------------------ |
| upstream-owned (M) | +2/-0  | oxlint-plugin-t3code/index.ts                                |
| fork-new           | +52/-0 | oxlint-plugin-t3code/rules/no-effect-expression-body.test.ts |
| fork-new           | +92/-0 | oxlint-plugin-t3code/rules/no-effect-expression-body.ts      |
| upstream-owned (M) | +1/-0  | vite.config.ts                                               |

## P demo dataset/tooling

- Files: 7 (1 upstream-owned, 6 fork-new); +2869/-0
- Reality: **(a) real tooling**
- Backend needed: none

`vp run dev:demo` (root package.json) + scripts/demo-environment.ts seed an isolated `.t3/demo-home` with fabricated projects/threads (demo-dataset.ts 1494 lines, tested; demo-activities, demo-database writes projection tables directly and empties the event log). useDemoUnreadSeed (mounted in AppSidebarLayout for ALL users) marks demo thread ids unread once per browser - harmless on real data but is demo code in the production path. RISK: `--reset` does `rm -rf` on whatever `--home-dir` is passed, with no guard against ~/.t3 or ~/.t3/userdata.

| Status             | +/-      | File                                                 |
| ------------------ | -------- | ---------------------------------------------------- |
| fork-new           | +34/-0   | apps/web/src/components/sidebar/useDemoUnreadSeed.ts |
| upstream-owned (M) | +1/-0    | package.json                                         |
| fork-new           | +269/-0  | scripts/demo-environment.ts                          |
| fork-new           | +466/-0  | scripts/lib/demo-activities.ts                       |
| fork-new           | +394/-0  | scripts/lib/demo-database.ts                         |
| fork-new           | +211/-0  | scripts/lib/demo-dataset.test.ts                     |
| fork-new           | +1494/-0 | scripts/lib/demo-dataset.ts                          |

## N feedback (Sentry)

- Files: 10 (3 upstream-owned, 7 fork-new); +648/-0
- Reality: **(a) real (when DSN set)**
- Backend needed: External: Sentry project + VITE_T3CODE_FEEDBACK_DSN at build time.

Rail feedback button: text + optional window screenshot (modern-screenshot, lazy-loaded; new dep in apps/web/package.json + pnpm-lock) + recent console warn/error buffer, posted as a Sentry envelope directly to the ingest endpoint (no SDK). Envelope encoder tested. Disabled with reason when DSN missing. feedbackLogs wraps console.warn/error globally (always on). DSN comes from repo .env (the worktree .env links to the main checkout's gitignored .env; DSN gets baked into the bundle - public by design, but means hosted builds ship it). Screenshots may capture sensitive on-screen content; opt-out checkbox exists.

| Status             | +/-     | File                                                               |
| ------------------ | ------- | ------------------------------------------------------------------ |
| upstream-owned (M) | +1/-0   | apps/web/package.json                                              |
| fork-new           | +206/-0 | apps/web/src/components/sidebar/feedback/SidebarFeedbackButton.tsx |
| fork-new           | +29/-0  | apps/web/src/components/sidebar/feedback/captureScreenshot.ts      |
| fork-new           | +104/-0 | apps/web/src/components/sidebar/feedback/feedbackEnvelope.test.ts  |
| fork-new           | +43/-0  | apps/web/src/components/sidebar/feedback/feedbackEnvelope.ts       |
| fork-new           | +91/-0  | apps/web/src/components/sidebar/feedback/feedbackLogs.ts           |
| fork-new           | +103/-0 | apps/web/src/components/sidebar/feedback/sendFeedback.ts           |
| fork-new           | +61/-0  | apps/web/src/components/sidebar/feedback/useFeedbackScreenshot.ts  |
| upstream-owned (M) | +2/-0   | apps/web/src/vite-env.d.ts                                         |
| upstream-owned (M) | +8/-0   | pnpm-lock.yaml                                                     |

## O header actions

- Files: 3 (1 upstream-owned, 2 fork-new); +249/-6
- Reality: **(c) mixed**
- Backend needed: Project binding for non-thread surfaces (shared chats, assistant, rooms) once those are real threads.

SurfaceHeaderActions gives fixture surfaces the real thread header controls (Actions, Open in, terminal, right panel) bound to a real project; useOpenInProjectThread hands off to the real thread view (real stores: rightPanelStore, terminal, entities). PanelLayoutControls gets label props (+14/-6).

| Status             | +/-     | File                                                          |
| ------------------ | ------- | ------------------------------------------------------------- |
| upstream-owned (M) | +14/-6  | apps/web/src/components/chat/PanelLayoutControls.tsx          |
| fork-new           | +154/-0 | apps/web/src/components/multiplayer/SurfaceHeaderActions.tsx  |
| fork-new           | +81/-0  | apps/web/src/components/multiplayer/useOpenInProjectThread.ts |

## I automations

- Files: 50 (0 upstream-owned, 50 fork-new); +6802/-0
- Reality: **(b) mock**
- Backend needed: Workflow engine (TS workflow source -> graph), triggers/hooks (schedule, inline hooks with latency), run persistence & run chat read model, approvals, review loops, scheduler; workflow-agent supervisor.

/automations, /automations/$id, Automations sidebar panel. automationFixtures.ts + 16 fixtures/*.ts (card bill, monthly expenses, sync upstream, triage Sentry, water plants, etc. - personal workflows), primitiveCatalog.ts (PLACEHOLDER CATALOG), runDecisions.ts (in-memory approve/reject), comingSoon.ts toasts for every write. Canvas pan/zoom, graph layout, node details are real client code over fixture data. Nothing persists, schedules, or executes.

| Status   | +/-     | File                                                              |
| -------- | ------- | ----------------------------------------------------------------- |
| fork-new | +141/-0 | apps/web/src/components/automations/AddStepPalette.tsx            |
| fork-new | +62/-0  | apps/web/src/components/automations/AutomationActionsMenu.tsx     |
| fork-new | +264/-0 | apps/web/src/components/automations/AutomationPage.tsx            |
| fork-new | +139/-0 | apps/web/src/components/automations/AutomationRunChat.tsx         |
| fork-new | +112/-0 | apps/web/src/components/automations/AutomationsOverviewPage.tsx   |
| fork-new | +197/-0 | apps/web/src/components/automations/AutomationsSidebarList.tsx    |
| fork-new | +80/-0  | apps/web/src/components/automations/PrimitivesReference.tsx       |
| fork-new | +73/-0  | apps/web/src/components/automations/RunApprovalActions.tsx        |
| fork-new | +44/-0  | apps/web/src/components/automations/RunIterations.tsx             |
| fork-new | +10/-0  | apps/web/src/components/automations/RunStatusMarker.tsx           |
| fork-new | +59/-0  | apps/web/src/components/automations/WorkflowAgent.tsx             |
| fork-new | +106/-0 | apps/web/src/components/automations/WorkflowCanvas.tsx            |
| fork-new | +246/-0 | apps/web/src/components/automations/WorkflowGraph.tsx             |
| fork-new | +105/-0 | apps/web/src/components/automations/WorkflowNodeCard.tsx          |
| fork-new | +227/-0 | apps/web/src/components/automations/WorkflowNodeConfigFields.tsx  |
| fork-new | +154/-0 | apps/web/src/components/automations/WorkflowNodeDetails.tsx       |
| fork-new | +81/-0  | apps/web/src/components/automations/WorkflowNodeExtraSections.tsx |
| fork-new | +62/-0  | apps/web/src/components/automations/WorkflowSourceView.tsx        |
| fork-new | +46/-0  | apps/web/src/components/automations/automationFixtures.ts         |
| fork-new | +81/-0  | apps/web/src/components/automations/automationFormat.ts           |
| fork-new | +259/-0 | apps/web/src/components/automations/automationModel.ts            |
| fork-new | +69/-0  | apps/web/src/components/automations/automationStatus.ts           |
| fork-new | +12/-0  | apps/web/src/components/automations/comingSoon.ts                 |
| fork-new | +210/-0 | apps/web/src/components/automations/fixtures/captureRouting.ts    |
| fork-new | +191/-0 | apps/web/src/components/automations/fixtures/cardBill.ts          |
| fork-new | +208/-0 | apps/web/src/components/automations/fixtures/customerReplies.ts   |
| fork-new | +166/-0 | apps/web/src/components/automations/fixtures/dangerCheck.ts       |
| fork-new | +84/-0  | apps/web/src/components/automations/fixtures/fixtureHelpers.ts    |
| fork-new | +139/-0 | apps/web/src/components/automations/fixtures/integrationHealth.ts |
| fork-new | +230/-0 | apps/web/src/components/automations/fixtures/monthlyExpenses.ts   |
| fork-new | +115/-0 | apps/web/src/components/automations/fixtures/noForcePush.ts       |
| fork-new | +142/-0 | apps/web/src/components/automations/fixtures/notionDigest.ts      |
| fork-new | +146/-0 | apps/web/src/components/automations/fixtures/reviewPrs.ts         |
| fork-new | +143/-0 | apps/web/src/components/automations/fixtures/sentryFeedback.ts    |
| fork-new | +287/-0 | apps/web/src/components/automations/fixtures/shipChange.ts        |
| fork-new | +234/-0 | apps/web/src/components/automations/fixtures/specToPr.ts          |
| fork-new | +181/-0 | apps/web/src/components/automations/fixtures/syncUpstream.ts      |
| fork-new | +180/-0 | apps/web/src/components/automations/fixtures/triageSentry.ts      |
| fork-new | +63/-0  | apps/web/src/components/automations/fixtures/waterPlants.ts       |
| fork-new | +163/-0 | apps/web/src/components/automations/fixtures/workOutOfSight.ts    |
| fork-new | +53/-0  | apps/web/src/components/automations/nodeDetailsParts.tsx          |
| fork-new | +380/-0 | apps/web/src/components/automations/primitiveCatalog.ts           |
| fork-new | +78/-0  | apps/web/src/components/automations/runDecisions.ts               |
| fork-new | +69/-0  | apps/web/src/components/automations/statusOwnerVisuals.tsx        |
| fork-new | +15/-0  | apps/web/src/components/automations/useAssistantName.ts           |
| fork-new | +165/-0 | apps/web/src/components/automations/useCanvasViewport.ts          |
| fork-new | +241/-0 | apps/web/src/components/automations/workflowNodeVisuals.tsx       |
| fork-new | +238/-0 | apps/web/src/components/sidebar/AutomationsSidebar.tsx            |
| fork-new | +33/-0  | apps/web/src/routes/automations.$automationId.tsx                 |
| fork-new | +19/-0  | apps/web/src/routes/automations.index.tsx                         |

## J plugins/skills/marketplace

- Files: 41 (0 upstream-owned, 41 fork-new); +5890/-0
- Reality: **(b) mock**
- Backend needed: Executor integration (connections, OAuth, MCP/API sources, health), access groups model, skills.sh install/publish + versioning, per-harness plugin marketplaces (Codex/Claude), AGENTS.md block compiler per role/scope/harness, team/project defaults presets.

/plugins (overview, connections, groups, skills, marketplace, harness plugins, instructions, defaults) + Plugins sidebar. pluginsFixtures.ts (641 lines, invented Gmail/Drive accounts), groupsFixtures, defaultsFixtures, instructionsFixtures, marketplaceFixtures (invented install counts), skillSharingFixtures; addedConnectionsStore in-memory; actions toast 'coming soon'. Instructions editor is in-memory and is the source the assistant pages read.

| Status   | +/-     | File                                                       |
| -------- | ------- | ---------------------------------------------------------- |
| fork-new | +205/-0 | apps/web/src/components/plugins/AddConnectionDialog.tsx    |
| fork-new | +115/-0 | apps/web/src/components/plugins/ConnectionAccounts.tsx     |
| fork-new | +111/-0 | apps/web/src/components/plugins/DefaultsPresetList.tsx     |
| fork-new | +250/-0 | apps/web/src/components/plugins/GroupDetail.tsx            |
| fork-new | +103/-0 | apps/web/src/components/plugins/GroupNewcomers.tsx         |
| fork-new | +124/-0 | apps/web/src/components/plugins/GroupsSection.tsx          |
| fork-new | +105/-0 | apps/web/src/components/plugins/HarnessPluginsSection.tsx  |
| fork-new | +131/-0 | apps/web/src/components/plugins/InstructionBlockEditor.tsx |
| fork-new | +99/-0  | apps/web/src/components/plugins/InstructionsPreview.tsx    |
| fork-new | +82/-0  | apps/web/src/components/plugins/InstructionsRoles.tsx      |
| fork-new | +180/-0 | apps/web/src/components/plugins/InstructionsSection.tsx    |
| fork-new | +171/-0 | apps/web/src/components/plugins/IntegrationDetail.tsx      |
| fork-new | +242/-0 | apps/web/src/components/plugins/IntegrationList.tsx        |
| fork-new | +238/-0 | apps/web/src/components/plugins/MarketplaceSection.tsx     |
| fork-new | +81/-0  | apps/web/src/components/plugins/NewcomerPreview.tsx        |
| fork-new | +117/-0 | apps/web/src/components/plugins/PluginsOverview.tsx        |
| fork-new | +135/-0 | apps/web/src/components/plugins/PluginsPage.tsx            |
| fork-new | +97/-0  | apps/web/src/components/plugins/PluginsSidebarNav.tsx      |
| fork-new | +203/-0 | apps/web/src/components/plugins/SkillDetail.tsx            |
| fork-new | +113/-0 | apps/web/src/components/plugins/SkillSharingDialogs.tsx    |
| fork-new | +179/-0 | apps/web/src/components/plugins/SkillSharingParts.tsx      |
| fork-new | +67/-0  | apps/web/src/components/plugins/SkillsFromRepo.tsx         |
| fork-new | +189/-0 | apps/web/src/components/plugins/SkillsSection.tsx          |
| fork-new | +61/-0  | apps/web/src/components/plugins/addedConnectionsStore.ts   |
| fork-new | +174/-0 | apps/web/src/components/plugins/defaultsFixtures.ts        |
| fork-new | +97/-0  | apps/web/src/components/plugins/defaultsModel.ts           |
| fork-new | +83/-0  | apps/web/src/components/plugins/groupPrimitives.tsx        |
| fork-new | +52/-0  | apps/web/src/components/plugins/groupsFixtures.ts          |
| fork-new | +225/-0 | apps/web/src/components/plugins/groupsModel.ts             |
| fork-new | +119/-0 | apps/web/src/components/plugins/instructionsFixtures.ts    |
| fork-new | +115/-0 | apps/web/src/components/plugins/instructionsModel.ts       |
| fork-new | +139/-0 | apps/web/src/components/plugins/marketplaceFixtures.ts     |
| fork-new | +641/-0 | apps/web/src/components/plugins/pluginsFixtures.ts         |
| fork-new | +203/-0 | apps/web/src/components/plugins/pluginsModel.ts            |
| fork-new | +104/-0 | apps/web/src/components/plugins/pluginsNav.ts              |
| fork-new | +159/-0 | apps/web/src/components/plugins/pluginsPrimitives.tsx      |
| fork-new | +74/-0  | apps/web/src/components/plugins/pluginsSearch.ts           |
| fork-new | +79/-0  | apps/web/src/components/plugins/skillSharingFixtures.ts    |
| fork-new | +67/-0  | apps/web/src/components/plugins/skillSharingModel.ts       |
| fork-new | +148/-0 | apps/web/src/components/sidebar/PluginsSidebar.tsx         |
| fork-new | +13/-0  | apps/web/src/routes/plugins.tsx                            |

## K spaces/PRs

- Files: 23 (0 upstream-owned, 23 fork-new); +3888/-0
- Reality: **(b) mock (PR link real)**
- Backend needed: Executor-brokered source sync (Drive/Notion/GitHub/Slack/Jira), per-section spaces, agent-facing file projection (/spaces/<path>), native notes persistence + backlinks + sharing.

/spaces (Library / Just Files lenses, previews, native Notion-style note editor with slash menu) + Spaces sidebar. spacesFixtures.ts (598 lines), spacesNotes.ts in-memory store, spacesFiles derived from fixtures. Only spacesPullRequests.ts touches real state: the Pull requests row links to upstream's real /pull-requests page (gated on a connected server that supports PRs).

| Status   | +/-     | File                                                       |
| -------- | ------- | ---------------------------------------------------------- |
| fork-new | +286/-0 | apps/web/src/components/sidebar/SpacesSidebar.tsx          |
| fork-new | +143/-0 | apps/web/src/components/spaces/SpacesAgentView.tsx         |
| fork-new | +126/-0 | apps/web/src/components/spaces/SpacesFileTree.tsx          |
| fork-new | +113/-0 | apps/web/src/components/spaces/SpacesGlyphs.tsx            |
| fork-new | +50/-0  | apps/web/src/components/spaces/SpacesHumanBody.tsx         |
| fork-new | +164/-0 | apps/web/src/components/spaces/SpacesItemViews.tsx         |
| fork-new | +67/-0  | apps/web/src/components/spaces/SpacesNoteBacklinks.tsx     |
| fork-new | +252/-0 | apps/web/src/components/spaces/SpacesNoteBlock.tsx         |
| fork-new | +259/-0 | apps/web/src/components/spaces/SpacesNoteEditor.tsx        |
| fork-new | +122/-0 | apps/web/src/components/spaces/SpacesNoteHeaderActions.tsx |
| fork-new | +50/-0  | apps/web/src/components/spaces/SpacesNotices.tsx           |
| fork-new | +274/-0 | apps/web/src/components/spaces/SpacesPage.tsx              |
| fork-new | +196/-0 | apps/web/src/components/spaces/SpacesPreviewPanel.tsx      |
| fork-new | +154/-0 | apps/web/src/components/spaces/SpacesRichPreview.tsx       |
| fork-new | +119/-0 | apps/web/src/components/spaces/SpacesSlashMenu.tsx         |
| fork-new | +61/-0  | apps/web/src/components/spaces/SpacesToolbar.tsx           |
| fork-new | +271/-0 | apps/web/src/components/spaces/spacesFiles.ts              |
| fork-new | +598/-0 | apps/web/src/components/spaces/spacesFixtures.ts           |
| fork-new | +167/-0 | apps/web/src/components/spaces/spacesModel.ts              |
| fork-new | +238/-0 | apps/web/src/components/spaces/spacesNotes.ts              |
| fork-new | +21/-0  | apps/web/src/components/spaces/spacesPullRequests.ts       |
| fork-new | +148/-0 | apps/web/src/components/spaces/spacesSpace.ts              |
| fork-new | +9/-0   | apps/web/src/routes/spaces.tsx                             |

## L usage/account pools

- Files: 13 (1 upstream-owned, 12 fork-new); +1166/-1
- Reality: **(c) mixed**
- Backend needed: Account pooling service (CLIProxyAPI or similar): pooled subscription accounts per harness, exit-server pins, weekly windows/banked resets, pool sharing ACLs; real burn-rate data for advice.

/accounts (Usage > Accounts) is mock: accountPoolsFixtures.ts (accounts + server pins come from devices/fleet.ts), usageAdvice.ts PLACEHOLDER math, SharePoolDialog local. Upstream Usage (tokens) page stays real; UsagePage.tsx only gains the UsageTabs header (+2/-1).

| Status             | +/-     | File                                                        |
| ------------------ | ------- | ----------------------------------------------------------- |
| fork-new           | +147/-0 | apps/web/src/components/accounts/AccountPoolsPage.tsx       |
| fork-new           | +170/-0 | apps/web/src/components/accounts/AccountRow.tsx             |
| fork-new           | +118/-0 | apps/web/src/components/accounts/PoolBlock.tsx              |
| fork-new           | +112/-0 | apps/web/src/components/accounts/PoolCapacityOverview.tsx   |
| fork-new           | +187/-0 | apps/web/src/components/accounts/SharePoolDialog.tsx        |
| fork-new           | +49/-0  | apps/web/src/components/accounts/UsageAdviceList.tsx        |
| fork-new           | +38/-0  | apps/web/src/components/accounts/UsageTabs.tsx              |
| fork-new           | +107/-0 | apps/web/src/components/accounts/accountPoolsFixtures.ts    |
| fork-new           | +144/-0 | apps/web/src/components/accounts/accountPoolsModel.ts       |
| fork-new           | +28/-0  | apps/web/src/components/accounts/accountPoolsPrimitives.tsx |
| fork-new           | +57/-0  | apps/web/src/components/accounts/usageAdvice.ts             |
| upstream-owned (M) | +2/-1   | apps/web/src/components/usage/UsagePage.tsx                 |
| fork-new           | +7/-0   | apps/web/src/routes/accounts.tsx                            |

## M devices/computers/team/setup

- Files: 37 (1 upstream-owned, 36 fork-new); +3321/-0
- Reality: **(b) mock**
- Backend needed: Devices: fleet/server registry, rolling updates/drain, client gateway capabilities. Computers: VM/desktop provisioning, streaming, billing. Team: orgs, invites, members, company agents (Clerk/WorkOS-type). Setup: CLI + MCP server + skill that don't exist yet.

/devices (fleet.ts, devicesFixtures), /computers + /computers/$id (computerFixtures, MockDesktopScene static drawing), /team (teamFixtures, members from multiplayer fixtures), /setup (setupFixtures: commands show 'intended shape'). CommandPalette gains 'Open setup' (+12; upstream changed CommandPalette +479/-52 since base -> conflict).

| Status             | +/-     | File                                                         |
| ------------------ | ------- | ------------------------------------------------------------ |
| upstream-owned (M) | +12/-0  | apps/web/src/components/CommandPalette.tsx                   |
| fork-new           | +24/-0  | apps/web/src/components/computers/ComputerChip.tsx           |
| fork-new           | +50/-0  | apps/web/src/components/computers/ComputerLiveView.tsx       |
| fork-new           | +55/-0  | apps/web/src/components/computers/ComputerPage.tsx           |
| fork-new           | +151/-0 | apps/web/src/components/computers/ComputerSessionDetails.tsx |
| fork-new           | +170/-0 | apps/web/src/components/computers/ComputerSessionPanel.tsx   |
| fork-new           | +120/-0 | apps/web/src/components/computers/ComputersIndexPage.tsx     |
| fork-new           | +284/-0 | apps/web/src/components/computers/MockDesktopScene.tsx       |
| fork-new           | +173/-0 | apps/web/src/components/computers/computerFixtures.ts        |
| fork-new           | +113/-0 | apps/web/src/components/computers/computerModel.ts           |
| fork-new           | +77/-0  | apps/web/src/components/computers/computerPrimitives.tsx     |
| fork-new           | +156/-0 | apps/web/src/components/devices/ClientDeviceCard.tsx         |
| fork-new           | +98/-0  | apps/web/src/components/devices/DevicesPage.tsx              |
| fork-new           | +118/-0 | apps/web/src/components/devices/RolloutDisclosure.tsx        |
| fork-new           | +192/-0 | apps/web/src/components/devices/ServersSection.tsx           |
| fork-new           | +75/-0  | apps/web/src/components/devices/devicesFixtures.ts           |
| fork-new           | +111/-0 | apps/web/src/components/devices/devicesModel.ts              |
| fork-new           | +177/-0 | apps/web/src/components/devices/fleet.ts                     |
| fork-new           | +64/-0  | apps/web/src/components/setup/CopyableCode.tsx               |
| fork-new           | +25/-0  | apps/web/src/components/setup/SetupChecklist.tsx             |
| fork-new           | +45/-0  | apps/web/src/components/setup/SetupPage.tsx                  |
| fork-new           | +62/-0  | apps/web/src/components/setup/SetupPromptBlock.tsx           |
| fork-new           | +112/-0 | apps/web/src/components/setup/SetupSurfaces.tsx              |
| fork-new           | +110/-0 | apps/web/src/components/setup/setupFixtures.ts               |
| fork-new           | +79/-0  | apps/web/src/components/team/AgentRepresentation.tsx         |
| fork-new           | +226/-0 | apps/web/src/components/team/MembersSection.tsx              |
| fork-new           | +101/-0 | apps/web/src/components/team/OrganizationsSection.tsx        |
| fork-new           | +54/-0  | apps/web/src/components/team/SignUpFlowCard.tsx              |
| fork-new           | +129/-0 | apps/web/src/components/team/TeamPage.tsx                    |
| fork-new           | +38/-0  | apps/web/src/components/team/teamFixtures.ts                 |
| fork-new           | +61/-0  | apps/web/src/components/team/teamModel.ts                    |
| fork-new           | +19/-0  | apps/web/src/components/team/teamPrimitives.tsx              |
| fork-new           | +12/-0  | apps/web/src/routes/computers.$computerId.tsx                |
| fork-new           | +7/-0   | apps/web/src/routes/computers.index.tsx                      |
| fork-new           | +7/-0   | apps/web/src/routes/devices.tsx                              |
| fork-new           | +7/-0   | apps/web/src/routes/setup.tsx                                |
| fork-new           | +7/-0   | apps/web/src/routes/team.tsx                                 |

## G assistant (Appa)

- Files: 46 (0 upstream-owned, 46 fork-new); +5422/-0
- Reality: **(b) mock**
- Backend needed: Assistant/supervisor agent runtime (new thread kind + orchestration), delegation/hand-off events & trace read model, daily-reset conversation, notification policy engine + push routing, per-user settings for identity/avatar/SOUL/USER/AGENTS.md (server-side), realtime voice for call page.

/assistant (default landing), /assistant/call, /agent/$agentId, Settings > Notifications. Everything conversational is canned: mockChatStore.ts appends locally and replies after a timer; assistantFixtures.ts (561 lines) and agentFixtures.ts invent agents/hand-offs; workflowAgents.ts derives from automation fixtures; AssistantCallPage is static. Real-ish client logic: avatar generator (avatarConfig/Faces/Shapes, tested), HarnessAvatar. localStorage-only: assistantIdentity (name 'Appa' default), useAssistantAvatar, assistantSoul (SOUL.md/USER.md), notificationPolicy. supervisorInstructions reads the in-memory Plugins > Instructions editor.

| Status   | +/-     | File                                                               |
| -------- | ------- | ------------------------------------------------------------------ |
| fork-new | +67/-0  | apps/web/src/components/assistant/AgentInstructionsDialog.tsx      |
| fork-new | +150/-0 | apps/web/src/components/assistant/AgentPage.tsx                    |
| fork-new | +137/-0 | apps/web/src/components/assistant/AssistantCallPage.tsx            |
| fork-new | +46/-0  | apps/web/src/components/assistant/AssistantComposer.tsx            |
| fork-new | +260/-0 | apps/web/src/components/assistant/AssistantConversation.tsx        |
| fork-new | +189/-0 | apps/web/src/components/assistant/AssistantCustomizeDialog.tsx     |
| fork-new | +71/-0  | apps/web/src/components/assistant/AssistantFreshStart.tsx          |
| fork-new | +118/-0 | apps/web/src/components/assistant/AssistantGlyphs.tsx              |
| fork-new | +21/-0  | apps/web/src/components/assistant/AssistantIcon.tsx                |
| fork-new | +254/-0 | apps/web/src/components/assistant/AssistantPage.tsx                |
| fork-new | +279/-0 | apps/web/src/components/assistant/AssistantTracePanel.tsx          |
| fork-new | +61/-0  | apps/web/src/components/assistant/CarriedOver.tsx                  |
| fork-new | +96/-0  | apps/web/src/components/assistant/ChatHeaderControls.tsx           |
| fork-new | +106/-0 | apps/web/src/components/assistant/ChatWithTrace.tsx                |
| fork-new | +129/-0 | apps/web/src/components/assistant/DelegationCard.tsx               |
| fork-new | +32/-0  | apps/web/src/components/assistant/MarkdownDoc.tsx                  |
| fork-new | +96/-0  | apps/web/src/components/assistant/NotificationDefaultsForm.tsx     |
| fork-new | +101/-0 | apps/web/src/components/assistant/NotificationMenu.tsx             |
| fork-new | +73/-0  | apps/web/src/components/assistant/NotificationRow.tsx              |
| fork-new | +286/-0 | apps/web/src/components/assistant/agentFixtures.ts                 |
| fork-new | +561/-0 | apps/web/src/components/assistant/assistantFixtures.ts             |
| fork-new | +33/-0  | apps/web/src/components/assistant/assistantIdentity.ts             |
| fork-new | +213/-0 | apps/web/src/components/assistant/assistantModel.ts                |
| fork-new | +78/-0  | apps/web/src/components/assistant/assistantSoul.ts                 |
| fork-new | +110/-0 | apps/web/src/components/assistant/avatar/AssistantAvatar.tsx       |
| fork-new | +110/-0 | apps/web/src/components/assistant/avatar/AssistantAvatarPicker.tsx |
| fork-new | +117/-0 | apps/web/src/components/assistant/avatar/avatarAccessories.tsx     |
| fork-new | +57/-0  | apps/web/src/components/assistant/avatar/avatarConfig.test.ts      |
| fork-new | +265/-0 | apps/web/src/components/assistant/avatar/avatarConfig.ts           |
| fork-new | +175/-0 | apps/web/src/components/assistant/avatar/avatarFaces.ts            |
| fork-new | +70/-0  | apps/web/src/components/assistant/avatar/avatarGeometry.test.ts    |
| fork-new | +224/-0 | apps/web/src/components/assistant/avatar/avatarShapes.ts           |
| fork-new | +23/-0  | apps/web/src/components/assistant/avatar/index.ts                  |
| fork-new | +17/-0  | apps/web/src/components/assistant/avatar/useAssistantAvatar.ts     |
| fork-new | +176/-0 | apps/web/src/components/assistant/mockChatStore.ts                 |
| fork-new | +93/-0  | apps/web/src/components/assistant/notificationPolicy.ts            |
| fork-new | +20/-0  | apps/web/src/components/assistant/supervisorInstructions.ts        |
| fork-new | +112/-0 | apps/web/src/components/assistant/useAssistantComposerSources.tsx  |
| fork-new | +49/-0  | apps/web/src/components/assistant/useOpenNode.ts                   |
| fork-new | +221/-0 | apps/web/src/components/assistant/workflowAgents.ts                |
| fork-new | +56/-0  | apps/web/src/components/chat/HarnessAvatar.tsx                     |
| fork-new | +21/-0  | apps/web/src/components/settings/NotificationSettingsPage.tsx      |
| fork-new | +22/-0  | apps/web/src/routes/agent.$agentId.tsx                             |
| fork-new | +7/-0   | apps/web/src/routes/assistant.call.tsx                             |
| fork-new | +9/-0   | apps/web/src/routes/assistant.index.tsx                            |
| fork-new | +11/-0  | apps/web/src/routes/settings.notifications.tsx                     |

## H multiplayer/sharing/rooms

- Files: 51 (2 upstream-owned, 49 fork-new); +6205/-4
- Reality: **(b) mock, leaking into real threads**
- Backend needed: Multi-user identity & org membership (beyond single-owner auth), per-item ACLs/sharing persisted server-side, presence, @mention notifications, shared threads with multiple human authors in contracts/orchestration, message author on user turns, assistant-to-assistant rooms with policy enforcement, forks.

/shared/$threadId, /rooms/$roomId, Share dialog, access bar, presence, mentions, reply modes, wait-for, forks, rooms. All data: multiplayerFixtures.ts (CURRENT_PERSON_ID='yannic', 'Yannic', Flynn, Samir, Northwind team), teamMessageFixtures, looseItemMessages, terminalAppMessages, roomFixtures (Appa/Pip/Halden). Local-only state: teamThreads visibility (localStorage), itemAccess grants (localStorage), localMessages + agentReply (canned turn), replyMode, agentWait, forks, rooms archive. SharedTimeline renders fixtures through the REAL MessagesTimeline via teamTimeline.ts (tested). LEAKS INTO REAL SURFACES: ChatHeader renders LocalThreadAccessBar on every real server thread (fixture people/Share button), and ChatView passes useThreadTimelineAnnotations so every real thread shows the fixture `currentPerson` (Yannic) avatar/name on user turns and 'current model' on all assistant turns (explicitly a placeholder: messages don't record the answering model).
Hot: MessagesTimeline +23/-4 (annotations prop + context, separator icon, header slots, author 'T3 Code'->APP_BASE_NAME), ChatHeader +9/-0.

| Status             | +/-     | File                                                        |
| ------------------ | ------- | ----------------------------------------------------------- |
| upstream-owned (M) | +9/-0   | apps/web/src/components/chat/ChatHeader.tsx                 |
| upstream-owned (M) | +23/-4  | apps/web/src/components/chat/MessagesTimeline.tsx           |
| fork-new           | +26/-0  | apps/web/src/components/chat/timelineAnnotations.ts         |
| fork-new           | +115/-0 | apps/web/src/components/multiplayer/AgentStatusRows.tsx     |
| fork-new           | +66/-0  | apps/web/src/components/multiplayer/ContainerCrumbs.tsx     |
| fork-new           | +49/-0  | apps/web/src/components/multiplayer/MentionPill.tsx         |
| fork-new           | +64/-0  | apps/web/src/components/multiplayer/MessageText.tsx         |
| fork-new           | +110/-0 | apps/web/src/components/multiplayer/PersonAvatar.tsx        |
| fork-new           | +115/-0 | apps/web/src/components/multiplayer/PersonProfile.tsx       |
| fork-new           | +52/-0  | apps/web/src/components/multiplayer/ReplyModeMenu.tsx       |
| fork-new           | +268/-0 | apps/web/src/components/multiplayer/ShareDialog.tsx         |
| fork-new           | +120/-0 | apps/web/src/components/multiplayer/ShareDialogControls.tsx |
| fork-new           | +290/-0 | apps/web/src/components/multiplayer/SharedThreadPage.tsx    |
| fork-new           | +135/-0 | apps/web/src/components/multiplayer/SharedTimeline.tsx      |
| fork-new           | +290/-0 | apps/web/src/components/multiplayer/TeamComposer.tsx        |
| fork-new           | +192/-0 | apps/web/src/components/multiplayer/ThreadAccessBar.tsx     |
| fork-new           | +37/-0  | apps/web/src/components/multiplayer/TimelineHeaders.tsx     |
| fork-new           | +83/-0  | apps/web/src/components/multiplayer/WaitForControl.tsx      |
| fork-new           | +155/-0 | apps/web/src/components/multiplayer/agentReply.ts           |
| fork-new           | +70/-0  | apps/web/src/components/multiplayer/agentWait.ts            |
| fork-new           | +117/-0 | apps/web/src/components/multiplayer/containerScope.ts       |
| fork-new           | +33/-0  | apps/web/src/components/multiplayer/draftIntake.ts          |
| fork-new           | +14/-0  | apps/web/src/components/multiplayer/fixtureAuthors.ts       |
| fork-new           | +62/-0  | apps/web/src/components/multiplayer/forks.ts                |
| fork-new           | +173/-0 | apps/web/src/components/multiplayer/itemAccess.ts           |
| fork-new           | +105/-0 | apps/web/src/components/multiplayer/localMessages.ts        |
| fork-new           | +184/-0 | apps/web/src/components/multiplayer/looseItemMessages.ts    |
| fork-new           | +111/-0 | apps/web/src/components/multiplayer/mentionDirectory.tsx    |
| fork-new           | +63/-0  | apps/web/src/components/multiplayer/mentions.test.ts        |
| fork-new           | +146/-0 | apps/web/src/components/multiplayer/mentions.ts             |
| fork-new           | +150/-0 | apps/web/src/components/multiplayer/multiplayerFixtures.ts  |
| fork-new           | +218/-0 | apps/web/src/components/multiplayer/multiplayerModel.ts     |
| fork-new           | +35/-0  | apps/web/src/components/multiplayer/personAssistant.ts      |
| fork-new           | +67/-0  | apps/web/src/components/multiplayer/replyMode.ts            |
| fork-new           | +220/-0 | apps/web/src/components/multiplayer/sharing.ts              |
| fork-new           | +205/-0 | apps/web/src/components/multiplayer/teamMessageFixtures.ts  |
| fork-new           | +237/-0 | apps/web/src/components/multiplayer/teamThreads.ts          |
| fork-new           | +125/-0 | apps/web/src/components/multiplayer/teamTimeline.test.ts    |
| fork-new           | +222/-0 | apps/web/src/components/multiplayer/teamTimeline.ts         |
| fork-new           | +181/-0 | apps/web/src/components/multiplayer/terminalAppMessages.ts  |
| fork-new           | +32/-0  | apps/web/src/components/multiplayer/threadAnnotations.tsx   |
| fork-new           | +274/-0 | apps/web/src/components/multiplayer/useAccessControls.tsx   |
| fork-new           | +80/-0  | apps/web/src/components/rooms/RoomComposer.tsx              |
| fork-new           | +130/-0 | apps/web/src/components/rooms/RoomMessageList.tsx           |
| fork-new           | +252/-0 | apps/web/src/components/rooms/RoomPage.tsx                  |
| fork-new           | +61/-0  | apps/web/src/components/rooms/RoomPolicyStrip.tsx           |
| fork-new           | +217/-0 | apps/web/src/components/rooms/roomFixtures.ts               |
| fork-new           | +82/-0  | apps/web/src/components/rooms/roomModel.ts                  |
| fork-new           | +104/-0 | apps/web/src/components/rooms/rooms.ts                      |
| fork-new           | +21/-0  | apps/web/src/routes/rooms.$roomId.tsx                       |
| fork-new           | +15/-0  | apps/web/src/routes/shared.$threadId.tsx                    |

## F capture / New bar

- Files: 16 (0 upstream-owned, 16 fork-new); +1820/-0
- Reality: **(c) mixed**
- Backend needed: Capture inbox/routing (where a capture goes, assistant hand-off), capture history, other-device capture (phone/watch/etc.), file upload for captures.

QuickCaptureHost mounted in AppSidebarLayout, opened by real `capture.open` keybinding (mod+shift+space) or New button. Real: draft persistence (captureDraftStore, localStorage), `#project` suggestions from real projects, 'open as full chat' creates a real T3 draft in a real project with text prefilled. Mock: `@assistant/@agent` destinations, `+person/team` sharing (captureVisibility), Recent captures + capture workflow (captureFixtures), CaptureSettingsPanel device list (PLACEHOLDERS). Files dropped onto the bar are live File objects, not persisted/uploaded.

| Status   | +/-     | File                                                     |
| -------- | ------- | -------------------------------------------------------- |
| fork-new | +174/-0 | apps/web/src/components/capture/CaptureContext.tsx       |
| fork-new | +58/-0  | apps/web/src/components/capture/CapturePage.tsx          |
| fork-new | +137/-0 | apps/web/src/components/capture/CaptureSettingsPanel.tsx |
| fork-new | +283/-0 | apps/web/src/components/capture/QuickCaptureForm.tsx     |
| fork-new | +73/-0  | apps/web/src/components/capture/QuickCaptureHost.tsx     |
| fork-new | +113/-0 | apps/web/src/components/capture/RecentCaptures.tsx       |
| fork-new | +89/-0  | apps/web/src/components/capture/captureDraftStore.ts     |
| fork-new | +151/-0 | apps/web/src/components/capture/captureFixtures.ts       |
| fork-new | +44/-0  | apps/web/src/components/capture/captureModel.ts          |
| fork-new | +98/-0  | apps/web/src/components/capture/captureTokens.test.ts    |
| fork-new | +177/-0 | apps/web/src/components/capture/captureTokens.ts         |
| fork-new | +36/-0  | apps/web/src/components/capture/captureVisibility.ts     |
| fork-new | +84/-0  | apps/web/src/components/capture/useCaptureAttachments.ts |
| fork-new | +162/-0 | apps/web/src/components/capture/useCaptureSuggestions.ts |
| fork-new | +134/-0 | apps/web/src/components/capture/useOpenAsFullChat.ts     |
| fork-new | +7/-0   | apps/web/src/routes/capture.tsx                          |

## E composer (send lock, full access, mock composer)

- Files: 22 (13 upstream-owned, 9 fork-new); +1119/-55
- Reality: **(c) mixed**
- Backend needed: Send lock: none (client localStorage, real). Full access: none, but it's a policy decision. Mock composer: needs server threads for assistant/agents/rooms/team chats.

Real: per-draft send lock (composerSendLockStore, localStorage 't3code:composer-send-lock:v1'; padlock latch on send button, `composer.toggleSendLock` keybinding, Enter inserts newline, ChatView onSend guard; pending approvals/questions never locked). Real & RISKY: lib/fullAccessPolicy.ts `ALWAYS_FULL_ACCESS = true` forces runtimeMode 'full-access' for every new and existing real thread on next send and removes the access picker (ChatView, useHandleNewThread, ChatComposer, CompactComposerControlsMenu). The comment assumes sandboxed durable objects, but today runs execute on the user's real machine/environments. Mixed: ChatComposer '@' now lists fixture teammates/agents (mentionDirectory -> TEAM_PEOPLE, agentFixtures) ahead of files in real chats. Mock: MockBoundComposer / MockComposerAgentControls / useComposerMentionMenu / useMockComposerAttachments reuse real composer parts for surfaces with no server thread (onSend -> local mock stores; attachments never uploaded). Contracts: +2 keybinding commands (composer.toggleSendLock, capture.open) in packages/contracts, default binding in packages/shared -> an older server rejecting unknown commands in keybindings config is a compat check to do.
Hot: ChatView +61/-19, ChatComposer +63/-2, ComposerPrimaryActions +38/-14, CompactComposerControlsMenu +20/-14, ComposerCommandMenu +12/-1, ComposerPromptEditor(+Tiptap) +25/-2.

| Status             | +/-     | File                                                         |
| ------------------ | ------- | ------------------------------------------------------------ |
| upstream-owned (M) | +61/-19 | apps/web/src/components/ChatView.tsx                         |
| upstream-owned (M) | +15/-2  | apps/web/src/components/ComposerPromptEditor.tsx             |
| upstream-owned (M) | +10/-0  | apps/web/src/components/ComposerPromptEditorTiptap.tsx       |
| upstream-owned (M) | +63/-2  | apps/web/src/components/chat/ChatComposer.tsx                |
| upstream-owned (M) | +20/-14 | apps/web/src/components/chat/CompactComposerControlsMenu.tsx |
| upstream-owned (M) | +12/-1  | apps/web/src/components/chat/ComposerCommandMenu.tsx         |
| upstream-owned (M) | +38/-14 | apps/web/src/components/chat/ComposerPrimaryActions.tsx      |
| fork-new           | +236/-0 | apps/web/src/components/chat/MockBoundComposer.tsx           |
| fork-new           | +167/-0 | apps/web/src/components/chat/MockComposerAgentControls.tsx   |
| fork-new           | +150/-0 | apps/web/src/components/chat/SendLockLatch.tsx               |
| fork-new           | +129/-0 | apps/web/src/components/chat/useComposerMentionMenu.tsx      |
| fork-new           | +75/-0  | apps/web/src/components/chat/useMockComposerAttachments.ts   |
| fork-new           | +15/-0  | apps/web/src/components/composerMentionRenderer.ts           |
| upstream-owned (M) | +25/-0  | apps/web/src/composer-logic.test.ts                          |
| upstream-owned (M) | +3/-0   | apps/web/src/composer-logic.ts                               |
| fork-new           | +23/-0  | apps/web/src/composerSendLockStore.test.ts                   |
| fork-new           | +53/-0  | apps/web/src/composerSendLockStore.ts                        |
| upstream-owned (M) | +4/-2   | apps/web/src/hooks/useHandleNewThread.test.ts                |
| upstream-owned (M) | +2/-1   | apps/web/src/hooks/useHandleNewThread.ts                     |
| fork-new           | +15/-0  | apps/web/src/lib/fullAccessPolicy.ts                         |
| upstream-owned (M) | +2/-0   | packages/contracts/src/keybindings.ts                        |
| upstream-owned (M) | +1/-0   | packages/shared/src/keybindings.ts                           |

## D pipeline relabel (Settle->Archive, Snooze->Later)

- Files: 11 (11 upstream-owned, 0 fork-new); +162/-167
- Reality: **(a) real**
- Backend needed: none (labels only) - but see behavior change below

Upstream Sidebar (now 'Pipeline' view) unchanged in behavior except: status rendering refactored into new threadStatusDisplay.ts (adds 'plan ready' state), Settle->Archive / Un-settle->Restore / Snooze->'Remind me later'/'Later' / Wake->'Bring back' / Woke->'Back' copy in Sidebar, ChatView banners, CustomSnoozeDialog, threadActionMenu, undo notice, settings (auto-settle -> auto-archive), keybinding label. Behavior change: threadActionMenu.logic hides upstream's real server-side 'Archive thread' action whenever the environment supports settlement (settle is now _called_ Archive) -> true archive is unreachable from that menu (one-way-door risk; two different 'archive' concepts now exist: server archive vs settle-labelled-archive vs Home's local archive-for-me). KeybindingsSettings.logic sort fix duplicates an upstream fix that landed since base (drop ours on sync).
Hot: Sidebar.tsx +62/-115 (also adds showChromeHeader prop).

| Status             | +/-      | File                                                          |
| ------------------ | -------- | ------------------------------------------------------------- |
| upstream-owned (M) | +5/-5    | apps/web/src/components/CustomSnoozeDialog.tsx                |
| upstream-owned (M) | +62/-115 | apps/web/src/components/Sidebar.tsx                           |
| upstream-owned (M) | +9/-1    | apps/web/src/components/settings/KeybindingsSettings.logic.ts |
| upstream-owned (M) | +5/-4    | apps/web/src/components/settings/KeybindingsSettings.tsx      |
| upstream-owned (M) | +16/-11  | apps/web/src/components/settings/SettingsPanels.tsx           |
| upstream-owned (M) | +6/-6    | apps/web/src/components/settings/settingsSearch.ts            |
| upstream-owned (M) | +9/-1    | apps/web/src/components/sidebar/SidebarThreadUndoNotice.tsx   |
| upstream-owned (M) | +22/-4   | apps/web/src/components/threadActionMenu.logic.test.ts        |
| upstream-owned (M) | +21/-13  | apps/web/src/components/threadActionMenu.logic.ts             |
| upstream-owned (M) | +5/-5    | apps/web/src/hooks/useThreadActionMenu.ts                     |
| upstream-owned (M) | +2/-2    | apps/web/src/hooks/useThreadActions.ts                        |

## C home tree/sections/chat-task kinds

- Files: 32 (0 upstream-owned, 32 fork-new); +4506/-0
- Reality: **(c) mixed**
- Backend needed: Server-persisted sections/containers + item placement + per-user archive/hide; thread kind (chat/task) on thread; loose (project-less) chats -> upstream #13612 'threads without a project' (scratch project) is now available upstream; team threads need multiplayer backend.

Home = Sections > Projects > items tree. Real: projects, threads, drafts, statuses (via shared threadStatusDisplay, also used by Pipeline), unread, shortcuts (state/entities, client-runtime). Mock/local: default sections (Work > Northwind team, Personal) and loose items are fixtures in sectionModel.ts; sectionStore.ts (localStorage: created/renamed/moved sections, project/item moves, collapsed, archived-for-me); threadKind.ts (title heuristic, localStorage overrides; 'Jev will classify'); itemSignals.ts (PLACEHOLDER fixture statuses); team project nodes and team threads from multiplayer fixtures; HomeSearch/useNeedsYouCount merge fixtures into counts (bell dot can be lit by fixtures).

| Status   | +/-     | File                                                            |
| -------- | ------- | --------------------------------------------------------------- |
| fork-new | +232/-0 | apps/web/src/components/sidebar/HomeDrafts.tsx                  |
| fork-new | +213/-0 | apps/web/src/components/sidebar/HomeSidebar.tsx                 |
| fork-new | +135/-0 | apps/web/src/components/sidebar/HomeSidebarTree.tsx             |
| fork-new | +287/-0 | apps/web/src/components/sidebar/HomeThreadRow.tsx               |
| fork-new | +50/-0  | apps/web/src/components/sidebar/draftEditTimes.ts               |
| fork-new | +128/-0 | apps/web/src/components/sidebar/sections/ArchivedList.tsx       |
| fork-new | +167/-0 | apps/web/src/components/sidebar/sections/HomeItemRow.tsx        |
| fork-new | +263/-0 | apps/web/src/components/sidebar/sections/HomeItems.tsx          |
| fork-new | +110/-0 | apps/web/src/components/sidebar/sections/HomeProjectNode.tsx    |
| fork-new | +182/-0 | apps/web/src/components/sidebar/sections/HomeSearch.tsx         |
| fork-new | +120/-0 | apps/web/src/components/sidebar/sections/HomeSectionNode.tsx    |
| fork-new | +162/-0 | apps/web/src/components/sidebar/sections/HomeTreeNode.tsx       |
| fork-new | +209/-0 | apps/web/src/components/sidebar/sections/NodeMenus.tsx          |
| fork-new | +125/-0 | apps/web/src/components/sidebar/sections/StatusMarkers.tsx      |
| fork-new | +71/-0  | apps/web/src/components/sidebar/sections/TeamProjectNode.tsx    |
| fork-new | +78/-0  | apps/web/src/components/sidebar/sections/ThreadKindIcon.tsx     |
| fork-new | +138/-0 | apps/web/src/components/sidebar/sections/containerContents.ts   |
| fork-new | +64/-0  | apps/web/src/components/sidebar/sections/containerIds.ts        |
| fork-new | +136/-0 | apps/web/src/components/sidebar/sections/homeMoves.ts           |
| fork-new | +93/-0  | apps/web/src/components/sidebar/sections/homeStatus.ts          |
| fork-new | +27/-0  | apps/web/src/components/sidebar/sections/itemSignals.ts         |
| fork-new | +17/-0  | apps/web/src/components/sidebar/sections/openHomeAgent.ts       |
| fork-new | +310/-0 | apps/web/src/components/sidebar/sections/sectionModel.ts        |
| fork-new | +212/-0 | apps/web/src/components/sidebar/sections/sectionStore.ts        |
| fork-new | +122/-0 | apps/web/src/components/sidebar/sections/threadKind.ts          |
| fork-new | +292/-0 | apps/web/src/components/sidebar/sections/useHomeSectionTree.ts  |
| fork-new | +22/-0  | apps/web/src/components/sidebar/sections/useItemScope.ts        |
| fork-new | +115/-0 | apps/web/src/components/sidebar/sections/useNeedsYouCount.ts    |
| fork-new | +27/-0  | apps/web/src/components/sidebar/sections/useOpenSharedThread.ts |
| fork-new | +149/-0 | apps/web/src/components/sidebar/useHomeSidebarData.ts           |
| fork-new | +72/-0  | apps/web/src/components/sidebar/useHomeThreadShortcuts.ts       |
| fork-new | +178/-0 | apps/web/src/components/threadStatusDisplay.ts                  |

## B app shell (rail, views, titlebar, settings nav)

- Files: 19 (9 upstream-owned, 10 fork-new); +1410/-157
- Reality: **(c) mixed**
- Backend needed: Rail/views are real UI; views they open are mostly mock. '/' now redirects to /assistant (mock).

View rail (Home, Pipeline, Spaces, Automations, Plugins; bottom: Usage, feedback, Focus, Settings), SidebarViews replaces the default ThreadSidebar in AppSidebarLayout (legacy sidebar setting still honoured), collapsible 'icon' mode, back/forward titlebar buttons, Settings > Workspace nav (team/devices/computers/setup/capture/notifications), sidebar width 16rem->19rem, mainAppLocation treats new pages as utility pages. `_chat.index.tsx` (-100 lines) deletes upstream's IndexDraftLanding/NoProjectsHero path and redirects "/" to `/assistant` (a mock page) -> real users land on placeholder UI. Focus store (localStorage) filters Home by Work/Personal using a name heuristic ("northwind"). routeTree.gen.ts +357 is generated (17 new routes). Brand link goes to /assistant.
Hot files: AppSidebarLayout +38/-17, SidebarChrome +74/-35, _chat.index +18/-100, mainAppLocation +13/-4.

| Status             | +/-      | File                                                       |
| ------------------ | -------- | ---------------------------------------------------------- |
| upstream-owned (M) | +38/-17  | apps/web/src/components/AppSidebarLayout.tsx               |
| upstream-owned (M) | +2/-0    | apps/web/src/components/settings/SettingsBreadcrumb.tsx    |
| upstream-owned (M) | +2/-0    | apps/web/src/components/settings/SettingsScopeSentence.tsx |
| upstream-owned (M) | +2/-0    | apps/web/src/components/settings/SettingsSidebarNav.tsx    |
| fork-new           | +52/-0   | apps/web/src/components/settings/SettingsWorkspaceNav.tsx  |
| upstream-owned (M) | +74/-35  | apps/web/src/components/sidebar/SidebarChrome.tsx          |
| fork-new           | +91/-0   | apps/web/src/components/sidebar/SidebarQuickActions.tsx    |
| fork-new           | +151/-0  | apps/web/src/components/sidebar/SidebarViewRail.tsx        |
| fork-new           | +129/-0  | apps/web/src/components/sidebar/SidebarViews.tsx           |
| fork-new           | +117/-0  | apps/web/src/components/sidebar/TitlebarHistoryButtons.tsx |
| fork-new           | +35/-0   | apps/web/src/components/sidebar/focus/FocusPausedChip.tsx  |
| fork-new           | +120/-0  | apps/web/src/components/sidebar/focus/FocusSwitcher.tsx    |
| fork-new           | +128/-0  | apps/web/src/components/sidebar/focus/focusStore.ts        |
| upstream-owned (M) | +13/-4   | apps/web/src/components/sidebar/mainAppLocation.ts         |
| fork-new           | +32/-0   | apps/web/src/components/sidebar/sidebarView.ts             |
| fork-new           | +46/-0   | apps/web/src/components/sidebar/useProjectInFocus.ts       |
| upstream-owned (M) | +3/-1    | apps/web/src/components/threadSidebarWidth.ts              |
| upstream-owned (M) | +357/-0  | apps/web/src/routeTree.gen.ts                              |
| upstream-owned (M) | +18/-100 | apps/web/src/routes/_chat.index.tsx                        |

## A branding (Signalbox name/icons; desktop+mobile+web)

- Files: 143 (141 upstream-owned, 2 fork-new); +389/-259
- Reality: **(a) real**
- Backend needed: none

Pure string/icon rename "T3 Code" -> "Signalbox" across desktop (37 files: every apps/desktop edit is a user-facing string, DMG SVG mark, gnome-extension name/description, productName; no behavior change), mobile (28 files: app names, permission strings, icons, CompactBrandTitle wordmark, widget mark frame 3:2 -> square), assets/ icon layer SVGs + PNGs (30), web favicons/index.html/branding.ts, scripts/build-desktop-artifact + export-android-icons. Identity is display-only: `userDataDirName` stays `t3code`/`t3code-dev`, `DESKTOP_APP_ID` unchanged, so user data is NOT orphaned. But `productName` changes the macOS .app bundle name and Linux desktop entry Name; Expo `appName` changes. New `SignalboxMark.tsx` on web+mobile (T3Wordmark kept, no deletions). Tests touched only to match new strings.
Merge surface: ~141 upstream-owned files with 1-3 line string edits; each upstream touch to those strings will conflict. Upstream already changed apps/mobile/app.config.ts (+50/-33), Stack.tsx, remoteRegistration.ts, AgentActivity.tsx since base -> conflicts on next sync. Cheaper long-term: route all names through APP_BASE_NAME/branding injection instead of literal edits.

| Status             | +/-     | File                                                                       |
| ------------------ | ------- | -------------------------------------------------------------------------- |
| upstream-owned (M) | +1/-1   | apps/desktop/gnome-extension/captureFeedback.js                            |
| upstream-owned (M) | +1/-1   | apps/desktop/gnome-extension/captureService.js                             |
| upstream-owned (M) | +3/-3   | apps/desktop/gnome-extension/captureService.test.js                        |
| upstream-owned (M) | +2/-2   | apps/desktop/gnome-extension/metadata.json                                 |
| upstream-owned (M) | +1/-1   | apps/desktop/package.json                                                  |
| upstream-owned (M) | +5/-4   | apps/desktop/resources/dmg/dmg-background-latest.svg                       |
| upstream-owned (M) | +5/-4   | apps/desktop/resources/dmg/dmg-background-nightly.svg                      |
| upstream-owned (M) | +3/-3   | apps/desktop/scripts/electron-launcher.mjs                                 |
| upstream-owned (M) | +2/-2   | apps/desktop/scripts/electron-launcher.test.mjs                            |
| upstream-owned (M) | +1/-1   | apps/desktop/src/app/DesktopApp.ts                                         |
| upstream-owned (M) | +1/-1   | apps/desktop/src/app/DesktopAppActivation.ts                               |
| upstream-owned (M) | +4/-4   | apps/desktop/src/app/DesktopAppActivationBroker.ts                         |
| upstream-owned (M) | +2/-2   | apps/desktop/src/app/DesktopAppIdentity.test.ts                            |
| upstream-owned (M) | +1/-1   | apps/desktop/src/app/DesktopEnvironment.ts                                 |
| upstream-owned (M) | +1/-1   | apps/desktop/src/app/DesktopPreReadyPlatform.test.ts                       |
| upstream-owned (M) | +2/-2   | apps/desktop/src/backend/DesktopBackendPool.ts                             |
| upstream-owned (M) | +1/-1   | apps/desktop/src/backend/DesktopLocalEnvironmentAuth.ts                    |
| upstream-owned (M) | +1/-1   | apps/desktop/src/electron/WindowsForeground.ts                             |
| upstream-owned (M) | +1/-1   | apps/desktop/src/permissions/MacPermissionHelper.test.ts                   |
| upstream-owned (M) | +3/-3   | apps/desktop/src/permissions/MacPermissionHelper.ts                        |
| upstream-owned (M) | +3/-3   | apps/desktop/src/snapShot/DesktopSnapShot.test.ts                          |
| upstream-owned (M) | +7/-7   | apps/desktop/src/snapShot/DesktopSnapShot.ts                               |
| upstream-owned (M) | +5/-5   | apps/desktop/src/snapShot/GnomeCaptureSetup.ts                             |
| upstream-owned (M) | +1/-1   | apps/desktop/src/snapShot/HyprlandSnapShot.ts                              |
| upstream-owned (M) | +2/-2   | apps/desktop/src/snapShot/KdeSnapShot.ts                                   |
| upstream-owned (M) | +1/-1   | apps/desktop/src/snapShot/LinuxSnapShot.ts                                 |
| upstream-owned (M) | +1/-1   | apps/desktop/src/snapShot/NiriCaptureShortcut.ts                           |
| upstream-owned (M) | +1/-1   | apps/desktop/src/snapShot/NiriSnapShot.ts                                  |
| upstream-owned (M) | +1/-1   | apps/desktop/src/snapShot/PortalCaptureShortcut.test.ts                    |
| upstream-owned (M) | +4/-4   | apps/desktop/src/snapShot/PortalCaptureShortcut.ts                         |
| upstream-owned (M) | +1/-1   | apps/desktop/src/snapShot/SnapShotTransition.ts                            |
| upstream-owned (M) | +1/-1   | apps/desktop/src/snapShot/snapShot.ts                                      |
| upstream-owned (M) | +1/-1   | apps/desktop/src/ssh/DesktopSshEnvironment.test.ts                         |
| upstream-owned (M) | +1/-1   | apps/desktop/src/ssh/DesktopSshEnvironment.ts                              |
| upstream-owned (M) | +1/-1   | apps/desktop/src/ssh/DesktopSshPasswordPrompts.ts                          |
| upstream-owned (M) | +1/-1   | apps/desktop/src/window/DesktopApplicationMenu.ts                          |
| upstream-owned (M) | +1/-1   | apps/desktop/src/wsl/DesktopWslEnvironment.ts                              |
| upstream-owned (M) | +9/-9   | apps/mobile/app.config.ts                                                  |
| upstream-owned (M) | +0/-0   | apps/mobile/assets/android-icon-background-dev.png                         |
| upstream-owned (M) | +0/-0   | apps/mobile/assets/android-icon-background-nightly.png                     |
| upstream-owned (M) | +0/-0   | apps/mobile/assets/android-icon-foreground.png                             |
| upstream-owned (M) | +0/-0   | apps/mobile/assets/android-icon-mark.png                                   |
| upstream-owned (M) | +0/-0   | apps/mobile/assets/android-notification-icon.png                           |
| upstream-owned (M) | +0/-0   | apps/mobile/assets/android-splash-icon-dev.png                             |
| upstream-owned (M) | +0/-0   | apps/mobile/assets/android-splash-icon-nightly.png                         |
| upstream-owned (M) | +0/-0   | apps/mobile/assets/android-splash-icon-prod.png                            |
| upstream-owned (M) | +3/-2   | apps/mobile/assets/widget/T3Mark.svg                                       |
| upstream-owned (M) | +1/-1   | apps/mobile/plugins/withWidgetLogoAsset.cjs                                |
| upstream-owned (M) | +1/-1   | apps/mobile/src/Stack.tsx                                                  |
| upstream-owned (M) | +1/-1   | apps/mobile/src/components/BrandMark.tsx                                   |
| upstream-owned (M) | +6/-6   | apps/mobile/src/components/CompactBrandTitle.tsx                           |
| fork-new           | +42/-0  | apps/mobile/src/components/SignalboxMark.tsx                               |
| upstream-owned (M) | +1/-1   | apps/mobile/src/features/agent-awareness/remoteRegistration.ts             |
| upstream-owned (M) | +2/-2   | apps/mobile/src/features/diagnostics/crash-log-model.test.ts               |
| upstream-owned (M) | +1/-1   | apps/mobile/src/features/diagnostics/crash-log-model.ts                    |
| upstream-owned (M) | +1/-1   | apps/mobile/src/features/settings/SettingsAboutRouteScreen.tsx             |
| upstream-owned (M) | +3/-3   | apps/mobile/src/features/settings/SettingsEnvironmentDetailRouteScreen.tsx |
| upstream-owned (M) | +2/-2   | apps/mobile/src/features/settings/SettingsNotificationsRouteScreen.tsx     |
| upstream-owned (M) | +1/-1   | apps/mobile/src/features/settings/SettingsRouteScreen.tsx                  |
| upstream-owned (M) | +1/-1   | apps/mobile/src/features/threads/ThreadComposer.tsx                        |
| upstream-owned (M) | +5/-2   | apps/mobile/src/features/threads/thread-work-log.tsx                       |
| upstream-owned (M) | +1/-1   | apps/mobile/src/lib/authClientMetadata.ts                                  |
| upstream-owned (M) | +1/-1   | apps/mobile/src/lib/connection.test.ts                                     |
| upstream-owned (M) | +1/-1   | apps/mobile/src/lib/mobileTheme.ts                                         |
| upstream-owned (M) | +3/-3   | apps/mobile/src/widgets/AgentActivity.tsx                                  |
| upstream-owned (M) | +3/-3   | apps/web/index.html                                                        |
| upstream-owned (M) | +0/-0   | apps/web/public/apple-touch-icon.png                                       |
| upstream-owned (M) | +0/-0   | apps/web/public/favicon-16x16.png                                          |
| upstream-owned (M) | +0/-0   | apps/web/public/favicon-32x32.png                                          |
| upstream-owned (M) | +0/-0   | apps/web/public/favicon.ico                                                |
| upstream-owned (M) | +2/-2   | apps/web/src/bootstrap.test.ts                                             |
| upstream-owned (M) | +2/-2   | apps/web/src/branding.test.ts                                              |
| upstream-owned (M) | +1/-1   | apps/web/src/branding.ts                                                   |
| upstream-owned (M) | +3/-2   | apps/web/src/cloud/linkEnvironment.ts                                      |
| upstream-owned (M) | +2/-1   | apps/web/src/components/RightPanelTabs.tsx                                 |
| upstream-owned (M) | +3/-2   | apps/web/src/components/ServerUpdateAction.tsx                             |
| fork-new           | +41/-0  | apps/web/src/components/SignalboxMark.tsx                                  |
| upstream-owned (M) | +3/-3   | apps/web/src/components/clerk/MobileClientsUserProfilePage.logic.test.ts   |
| upstream-owned (M) | +2/-1   | apps/web/src/components/clerk/MobileClientsUserProfilePage.logic.ts        |
| upstream-owned (M) | +2/-1   | apps/web/src/components/clerk/MobileClientsUserProfilePage.tsx             |
| upstream-owned (M) | +5/-4   | apps/web/src/components/cloud/RelayClientInstallDialog.tsx                 |
| upstream-owned (M) | +4/-1   | apps/web/src/components/desktop/DesktopAppActivationCoordinator.tsx        |
| upstream-owned (M) | +3/-1   | apps/web/src/components/desktop/SshPasswordPromptDialog.tsx                |
| upstream-owned (M) | +3/-3   | apps/web/src/components/desktopUpdate.logic.test.ts                        |
| upstream-owned (M) | +5/-4   | apps/web/src/components/desktopUpdate.logic.ts                             |
| upstream-owned (M) | +2/-1   | apps/web/src/components/onboarding/FirstRunGate.tsx                        |
| upstream-owned (M) | +7/-11  | apps/web/src/components/onboarding/WelcomeWizard.tsx                       |
| upstream-owned (M) | +2/-1   | apps/web/src/components/preview/PreviewPanel.tsx                           |
| upstream-owned (M) | +9/-6   | apps/web/src/components/settings/BrowserImportWizard.tsx                   |
| upstream-owned (M) | +8/-7   | apps/web/src/components/settings/CaptureShortcutConfig.tsx                 |
| upstream-owned (M) | +3/-2   | apps/web/src/components/settings/ChatGptWelcomeCoordinator.tsx             |
| upstream-owned (M) | +7/-4   | apps/web/src/components/settings/CodexSetupSection.tsx                     |
| upstream-owned (M) | +12/-11 | apps/web/src/components/settings/ConnectionsSettings.tsx                   |
| upstream-owned (M) | +2/-1   | apps/web/src/components/settings/IntegrationsSettings.tsx                  |
| upstream-owned (M) | +4/-3   | apps/web/src/components/settings/LocalEnvironmentSetting.tsx               |
| upstream-owned (M) | +2/-1   | apps/web/src/components/settings/NotificationSettings.tsx                  |
| upstream-owned (M) | +1/-1   | apps/web/src/components/settings/SnapShotSettings.logic.test.ts            |
| upstream-owned (M) | +4/-2   | apps/web/src/components/settings/SnapShotSettings.tsx                      |
| upstream-owned (M) | +6/-7   | apps/web/src/components/settings/SnapShotSetupDialog.tsx                   |
| upstream-owned (M) | +2/-1   | apps/web/src/components/settings/ThemeImportDialog.tsx                     |
| upstream-owned (M) | +2/-1   | apps/web/src/components/settings/ThemePreviewCircles.tsx                   |
| upstream-owned (M) | +3/-1   | apps/web/src/components/settings/providerStatus.ts                         |
| upstream-owned (M) | +1/-1   | apps/web/src/connection/clientMetadata.test.ts                             |
| upstream-owned (M) | +3/-2   | apps/web/src/connection/clientMetadata.ts                                  |
| upstream-owned (M) | +4/-3   | apps/web/src/desktopAppActivation.ts                                       |
| upstream-owned (M) | +4/-2   | apps/web/src/lib/bootError.ts                                              |
| upstream-owned (M) | +2/-1   | apps/web/src/routes/_chat.pull-requests.tsx                                |
| upstream-owned (M) | +2/-1   | apps/web/src/routes/_chat.tsx                                              |
| upstream-owned (M) | +2/-2   | apps/web/src/versionSkew.test.ts                                           |
| upstream-owned (M) | +2/-2   | apps/web/src/versionSkew.ts                                                |
| upstream-owned (M) | +3/-3   | assets/README.md                                                           |
| upstream-owned (M) | +15/-16 | assets/dev/app-icon.icon/Assets/annotations.svg                            |
| upstream-owned (M) | +2/-1   | assets/dev/app-icon.icon/Assets/text.svg                                   |
| upstream-owned (M) | +0/-0   | assets/dev/blueprint-ios-1024.png                                          |
| upstream-owned (M) | +0/-0   | assets/dev/blueprint-macos-1024.png                                        |
| upstream-owned (M) | +0/-0   | assets/dev/blueprint-universal-1024.png                                    |
| upstream-owned (M) | +0/-0   | assets/dev/blueprint-web-apple-touch-180.png                               |
| upstream-owned (M) | +0/-0   | assets/dev/blueprint-web-favicon-16x16.png                                 |
| upstream-owned (M) | +0/-0   | assets/dev/blueprint-web-favicon-32x32.png                                 |
| upstream-owned (M) | +0/-0   | assets/dev/blueprint-web-favicon.ico                                       |
| upstream-owned (M) | +0/-0   | assets/dev/blueprint-windows.ico                                           |
| upstream-owned (M) | +2/-1   | assets/nightly/app-icon.icon/Assets/text.svg                               |
| upstream-owned (M) | +0/-0   | assets/nightly/nightly-ios-1024.png                                        |
| upstream-owned (M) | +0/-0   | assets/nightly/nightly-macos-1024.png                                      |
| upstream-owned (M) | +0/-0   | assets/nightly/nightly-universal-1024.png                                  |
| upstream-owned (M) | +0/-0   | assets/nightly/nightly-web-apple-touch-180.png                             |
| upstream-owned (M) | +0/-0   | assets/nightly/nightly-web-favicon-16x16.png                               |
| upstream-owned (M) | +0/-0   | assets/nightly/nightly-web-favicon-32x32.png                               |
| upstream-owned (M) | +0/-0   | assets/nightly/nightly-web-favicon.ico                                     |
| upstream-owned (M) | +0/-0   | assets/nightly/nightly-windows.ico                                         |
| upstream-owned (M) | +2/-1   | assets/prod/app-icon.icon/Assets/text.svg                                  |
| upstream-owned (M) | +0/-0   | assets/prod/black-ios-1024.png                                             |
| upstream-owned (M) | +0/-0   | assets/prod/black-macos-1024.png                                           |
| upstream-owned (M) | +0/-0   | assets/prod/black-universal-1024.png                                       |
| upstream-owned (M) | +2/-1   | assets/prod/logo.svg                                                       |
| upstream-owned (M) | +0/-0   | assets/prod/t3-black-web-apple-touch-180.png                               |
| upstream-owned (M) | +0/-0   | assets/prod/t3-black-web-favicon-16x16.png                                 |
| upstream-owned (M) | +0/-0   | assets/prod/t3-black-web-favicon-32x32.png                                 |
| upstream-owned (M) | +0/-0   | assets/prod/t3-black-web-favicon.ico                                       |
| upstream-owned (M) | +0/-0   | assets/prod/t3-black-windows.ico                                           |
| upstream-owned (M) | +5/-5   | scripts/build-desktop-artifact.test.ts                                     |
| upstream-owned (M) | +5/-5   | scripts/build-desktop-artifact.ts                                          |
| upstream-owned (M) | +13/-8  | scripts/export-android-icons.ts                                            |
