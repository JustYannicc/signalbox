# Signalbox: upstream compatibility, release pipeline, telemetry

Evidence snapshot, 2026-10-01. Worktree `<worktree>`
(branch `t3code/codex-style-sidebar`, HEAD = origin/main = `53de792f13`).
upstream/main = `5a574a77d1`. merge-base(HEAD, upstream/main) = `c18e5ea6ed`, 34 upstream commits behind.
All Signalbox work is uncommitted: 185 modified tracked files (+1308/-649) and 72 untracked entries
(343 files). Nothing is pushed, so a disk or worktree accident loses all of it.

---

## 1. Upstream release pipeline

### Workflow map (`.github/workflows/`)

| Workflow                                                                                                                                     | Trigger                                                                                                           | Publishes / does                                                                                                                                                                                                                                                                                                                                                                     | Secrets / vars                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `release.yml`                                                                                                                                | cron `8,38 * * * *` (nightly when ≥6h and new commits), tag `v*.*.*`, dispatch `channel=preview\|stable\|nightly` | Whole train: resolve commit → quality/tests → `relay_public_config` (reads T3 Connect Alchemy state from Cloudflare) → `build_bundle` (JS once) → 6 desktop jobs → `publish_cli` (npm) → `release` (GitHub Release + merged updater manifests) → `publish_aur`, `deploy_web` (Vercel), `deploy_marketing` (nightly), `finalize` (stable version bump commit via GitHub App), Discord | `CLOUDFLARE_API_TOKEN`, `VERCEL_TOKEN/ORG_ID/PROJECT_ID`, `RELEASE_APP_ID/PRIVATE_KEY`, `AUR_SSH_PRIVATE_KEY`, `DISCORD_*`; vars `CLOUDFLARE_ACCOUNT_ID`, `RELAY_*`, `CLERK_*`, `T3CODE_WEB_*_DOMAIN`, `VERCEL_TEAM_SLUG`. npm uses OIDC trusted publishing (no token) |
| `release-desktop.yml`                                                                                                                        | `workflow_call` per platform/arch                                                                                 | electron-builder via `vp run dist:desktop:artifact`; CLI single-exe archive (`scripts/build-cli-archive.ts`) + smoke test; uploads `desktop-*`, `cli-*` artifacts                                                                                                                                                                                                                    | mac: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY/_ID/_ISSUER`, `MACOS_PROVISIONING_PROFILE`, var `APPLE_TEAM_ID`, `CLERK_PASSKEY_RP_DOMAINS`. win: `AZURE_*` Trusted Signing (7 secrets). Signing is auto-skipped when secrets are missing                          |
| `desktop-macos-preview.yml` + `-publish.yml`                                                                                                 | PR label `preview:mac`                                                                                            | signed DMG to rolling `desktop-preview` prerelease                                                                                                                                                                                                                                                                                                                                   | Apple secrets                                                                                                                                                                                                                                                          |
| `web-preview.yml`                                                                                                                            | PR label `preview:web`                                                                                            | Vercel preview deploy                                                                                                                                                                                                                                                                                                                                                                | Vercel                                                                                                                                                                                                                                                                 |
| `deploy-relay.yml`                                                                                                                           | push main (relay paths), dispatch                                                                                 | T3 Connect relay to Cloudflare (Alchemy)                                                                                                                                                                                                                                                                                                                                             | Cloudflare, PlanetScale, Clerk, APNs, FCM, Axiom                                                                                                                                                                                                                       |
| `mobile-eas-production.yml`                                                                                                                  | push main (mobile paths), dispatch                                                                                | EAS store build + auto-submit (TestFlight / Play internal) when `version` changes; else `eas update` OTA to `production` channel when fingerprint matches                                                                                                                                                                                                                            | `EXPO_TOKEN`, release GitHub App                                                                                                                                                                                                                                       |
| `mobile-eas-preview.yml`                                                                                                                     | PR label                                                                                                          | EAS preview builds/OTA                                                                                                                                                                                                                                                                                                                                                               | `EXPO_TOKEN`                                                                                                                                                                                                                                                           |
| `mobile-fingerprint-check.yml`, `mobile-showcase-screenshots.yml`                                                                            | PR / dispatch                                                                                                     | native-change label, store screenshots                                                                                                                                                                                                                                                                                                                                               | none / -                                                                                                                                                                                                                                                               |
| `publish-aur.yml`                                                                                                                            | called by release                                                                                                 | AUR package                                                                                                                                                                                                                                                                                                                                                                          | `AUR_SSH_PRIVATE_KEY`                                                                                                                                                                                                                                                  |
| `ci.yml`, `windows-tests.yml`, `pr-size.yml`, `pr-vouch.yml`, `issue-labels.yml`, `thread-transfer-report.yml`, `cursor-hygiene-webhook.yml` | PR/push                                                                                                           | checks and repo hygiene                                                                                                                                                                                                                                                                                                                                                              | Cursor webhook secrets                                                                                                                                                                                                                                                 |

Docs: `docs/operations/release.md` (authoritative), `docs/internals/server-updates.md`.

### Channels and versions

- Stable: `vX.Y.Z`, built from the commit of the latest nightly ("promote the nightly"). npm dist-tag `latest`, web alias `latest.app.t3.codes` + `app.t3.codes`.
- Nightly: `vX.Y.Z-nightly.YYYYMMDD.<run>` (`scripts/resolve-nightly-release.ts`), GitHub prerelease, npm `nightly`, web `nightly.app.t3.codes`. Upstream ships about 3 to 6 nightlies/day (e.g. 4 on 2026-09-30). Latest stable is `v0.0.44` (2026-09-29).
- Preview: `-preview.` versions with no publish config, no updater manifests, npm `preview`.

### Desktop auto-update feed

- `scripts/build-desktop-artifact.ts` `resolveGitHubPublishConfig`: repo = `T3CODE_DESKTOP_UPDATE_REPOSITORY` → else `GITHUB_REPOSITORY` → else no feed. `provider: github`, nightly uses `channel: nightly` + `releaseType: prerelease`. Channel comes from the version regex `-nightly\.\d{8}\.\d+$` (`resolveDesktopUpdateChannel`).
- Manifests: `latest*.yml` / `nightly*.yml` + `*.blockmap`. Per-arch mac/win manifests are merged in the `release` job (`scripts/merge-update-manifests.ts`). macOS needs the `.zip` (Squirrel.Mac).
- Runtime: `apps/desktop/src/updates/DesktopUpdates.ts`, `apps/desktop/src/electron/ElectronUpdater.ts`. Check-only, then the user clicks to download and install.
- Running the build inside the fork's own Actions sets `GITHUB_REPOSITORY=JustYannicc/t3code` automatically, so the AGENTS.md env var only matters for local builds.

### Hidden upstream coupling (matters for the fork)

- **Server self-update / SSH / boot service download CLI archives from upstream**: `packages/shared/src/cliRelease.ts:8` `CLI_RELEASE_REPOSITORY = "pingdotgg/t3code"` (override only via runtime `T3CODE_RELEASE_BASE_URL`). A Signalbox client asking a server to "Update server" to its version pulls upstream's release, which doesn't exist or isn't Signalbox. Also used by `scripts/install.sh` (`repo="pingdotgg/t3code"`).
- Release-history link: `apps/web/src/components/desktopUpdate.logic.ts:6`.
- Model manifest fetch: `apps/server/src/provider/ModelManifest.ts:41` (raw upstream main). Harmless data, keep it.
- Triage CLI prompt points at upstream issues: `apps/server/src/cli/triagePrompt.ts`.
- npm package `t3` + `@t3code/t3-<platform>` (`apps/server/package.json`, `scripts/build-npm-platform-packages.ts:47`). The fork cannot publish these names.
- T3 Connect (relay/Clerk) is upstream infra. `relay_public_config` hard-fails without upstream Cloudflare state.

### Signalbox identity is only cosmetic right now

The worktree renames display strings (`productName "Signalbox (Alpha)"`, `APP_BASE_NAME = "Signalbox"`, mobile `appName`). It still shares every real identity with T3 Code, so Signalbox cannot coexist with an installed T3 Code:

- `appId` `com.t3tools.t3code` (`scripts/build-desktop-artifact.ts:57`), `appUserModelId` (`DesktopEnvironment.ts:242`)
- userData dir `t3code` (`DesktopEnvironment.ts:191`), so the single-instance lock collides
- T3 home `~/.t3` (`DesktopStatePaths.ts:19`) → same SQLite DB as real T3 Code. Running both means one app's migrations can break the other.
- URL schemes `t3code`/`t3code-dev`, Linux `executableName`/WMClass `t3code`, artifactName `T3-Code-…`
- server port 3773 (`apps/server/src/config.ts:23`), `T3CODE_HOME` env
- mobile bundle IDs `com.t3tools.t3code[.dev|.preview]`, EAS `owner: pingdotgg`, `projectId d763fcb8-…`, OTA url, `ascAppId 6787819824` (`apps/mobile/app.config.ts`, `apps/mobile/eas.json`)

### The fork's Actions are currently live and broken

`gh api repos/JustYannicc/t3code/actions/workflows` shows all 18 workflows `active`. The `Release` cron has 4 runs stuck pending/queued (`36871905961`, …), and `CI`/`Deploy T3 Connect relay` are queued. They target `blacksmith-*` runners that only exist in pingdotgg's org. The fork has 0 secrets and 0 variables, so nothing can publish. These runs just pile up.

### Prior art: NateWeav/t3code-hermes (a public t3code fork that solved this in Sept 2026)

- #27 separate identity (`t3-hermes`, `~/.t3-hermes`, port 4773, own app IDs/profiles/services, mobile ids)
- #64 macOS in-app updates without an Apple cert: stable **self-signed** identity (`MACOS_SELF_SIGNED_P12`) → stable designated requirement → Squirrel.Mac accepts updates. Ad-hoc signing fails ("code failed to satisfy specified code requirement(s)").
- #60 `sync-upstream.yml` merges every 3h, then dispatches a fork nightly when main contains upstream's latest nightly commit
- #70 telemetry + triage pointed at the fork; #33/#52 npm `t3-hermes` via trusted publishing (npm spam filter blocked `*-win32-*` names)
- FORK.md "CI on the fork": GitHub-hosted runners, `if: github.repository == 'pingdotgg/t3code'` guards on upstream-infra workflows, T3 Connect resolves to empty (disabled), unsigned sideloadable `.ipa`/`.apk`.

## 1b. What Signalbox must set up

### Minimum viable (2 users, macOS-first)

1. **Commit and push the work** to a fork branch first.
2. **Stop the broken Actions**: `gh workflow disable` every upstream workflow in JustYannicc/t3code. That is repo state, so it doesn't touch files or conflict. Add the fork's own workflow later.
3. **Real identity** (one cohesive fork module plus minimal hooks): appId `com.justyannicc.signalbox` (or similar), userData `signalbox`, home `~/.signalbox` + `SIGNALBOX_HOME`, port e.g. 4783, URL scheme `signalbox`, artifactName `Signalbox-…`, Linux executable `signalbox`. Leave the T3 Connect/Clerk callback schemes alone, because Connect stays disabled.
4. **One fork release workflow** (new file, e.g. `.github/workflows/signalbox-release.yml`, not edits to `release.yml`). GitHub-hosted `macos-14`/`macos-latest` arm64 (+ x64 if needed). Run `vp run build:desktop` with relay/Clerk env empty, then `vp run dist:desktop:artifact --platform mac --target dmg --arch arm64 --build-version <v>`. Publish to a GitHub Release on JustYannicc/t3code with `*.dmg *.zip *.blockmap latest-mac.yml|nightly-mac.yml`. Versions: nightly `X.Y.Z-nightly.YYYYMMDD.N` (must match the regex), stable `vX.Y.Z` marked latest. The feed resolves from `GITHUB_REPOSITORY` automatically.
5. **macOS signing**: generate one self-signed code-signing cert, store it as `MACOS_SELF_SIGNED_P12` (+ password), and port hermes #64 (`scripts/sign-macos.ts` identity swap, `hardenedRuntime:false`, `timestamp:"none"`). Users install the first build by hand (`xattr -dr com.apple.quarantine`). Later updates go through the in-app updater. Verify with `codesign -d -r-` and `codesign --verify -R=…` across two builds.
6. **Telemetry**: change the default PostHog key, or set `T3CODE_TELEMETRY_ENABLED=false` by default (see §3).
7. Skip npm, hosted web, mobile store, AUR, relay, Windows signing. Point `CLI_RELEASE_REPOSITORY` at the fork and attach CLI archives only if remote servers/SSH matter. Otherwise the in-app "Update server" for remote hosts stays broken.

Cost: $0. Risk: the self-signed path is proven by hermes on codesign level, but an end-to-end Squirrel update must be tested once.

### Full path

- Apple Developer Program ($99/yr): Developer ID cert → `CSC_LINK/CSC_KEY_PASSWORD`, App Store Connect API key → `APPLE_API_KEY/_ID/_ISSUER`, `APPLE_TEAM_ID`. Upstream's build also requires `MACOS_PROVISIONING_PROFILE` whenever signing is on (passkey entitlements for Clerk). Fork must either make that optional or create its own profile for its own app ID. Switching from self-signed to Developer ID breaks the designated requirement, so plan one manual reinstall.
- Windows: Azure Trusted Signing (~$10/mo) or ship unsigned (SmartScreen warnings).
- Linux: AppImage/deb unsigned is fine.
- npm: own unscoped name (e.g. `signalbox` / `@justyannicc/signalbox-<platform>`). Packages must be created by hand once before OIDC trusted publishing works (hermes #52). Patch `NPM_LAUNCHER_PACKAGE_NAME` + platform package names.
- Hosted web: own Vercel/CF Pages project + domain, or drop it (desktop and `npx` serve the bundled web client).
- Mobile: own EAS project (`owner`, `projectId`, `updates.url`), bundle IDs `com.justyannicc.signalbox[.dev|.preview]`, own ASC app (`ascAppId`) and Play listing. Two-user shortcut: Android sideload APK; iOS via TestFlight (needs the paid Apple account) or `T3CODE_IOS_PERSONAL_TEAM=1` + `T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID` (free team, 7-day re-sign).
- T3 Connect: needs own Cloudflare/Clerk/PlanetScale/APNs/FCM/Axiom stack (`infra/relay`). Not worth it for 2 users; Tailscale + `pair` covers remote.

---

## 2. Upstream compatibility

### Current sync mechanism

A local Codex automation runs a daily 03:00 heartbeat. It merges or fast-forwards upstream main into the main checkout and pushes origin main, stopping on conflict. **`status = "PAUSED"`**, and origin/main is already 34 commits behind. It only syncs `main`, which holds none of the Signalbox code.

### Upstream velocity (squash-merged, linear history)

- Commits on main per month: Jun 410, Jul 365, Aug 687, **Sep 1599**. Last 4 full weeks were 744 / 298 / 295 / 244 per week, so roughly 40 to 100 per day.
- 2294 commits in 60 days. Top authors: Julius Marminge 725, Theo Browne 402, maria 246, t3-code[bot] 90.
- Churn by area (file-touches, 60d, excluding `.repos/`): `apps/web/src` 6172, `apps/server/src` 3948, `apps/mobile/src` 2516, `apps/desktop/src` 790, `packages/client-runtime` 710, `packages/contracts` 583.
- Hottest files (commits/60d): `ChatView.tsx` 210, `Sidebar.tsx` 130, `MessagesTimeline.tsx` 126, `pnpm-lock.yaml` 117, `ChatComposer.tsx` 109, `ws.ts` 85, `contracts/settings.ts` 80, `SettingsPanels.tsx` 78, `settingsSearch.ts` 69, `LegacySidebar.tsx` 51, `CommandPalette.tsx` 48.

### Fork footprint vs upstream churn

- 141 modified non-asset files + 44 assets. **80 of the 141 are pure branding string swaps** ("T3 Code"→"Signalbox", 137 occurrences in 70 files). Those are pure merge noise.
- Functional edits in hot files (upstream commits/60d, fork diff): `ChatView.tsx` 210 (+61/-19), `Sidebar.tsx` 130 (+62/-115), `MessagesTimeline.tsx` 126 (+23/-4), `ChatComposer.tsx` 109 (+63/-2), `SettingsPanels.tsx` 78, `settingsSearch.ts` 69, `CommandPalette.tsx` 48 (+12), `ConnectionsSettings.tsx` 41, `SidebarChrome.tsx` 28 (+74/-35), `AppSidebarLayout.tsx` 20 (+38/-17), `_chat.index.tsx` (+18/-100), `routeTree.gen.ts` (+357, generated), `ComposerPrimaryActions.tsx` (+38/-14), keybinding contracts.
- **Trial merge** (WIP snapshot commit `b9396c2756`, a dangling object; `git merge-tree --write-tree` vs `upstream/main`). After 1.5 days of upstream (34 commits), 5 files already conflict: `apps/mobile/app.config.ts`, `apps/mobile/src/features/agent-awareness/remoteRegistration.ts`, `apps/web/src/components/chat/ChatComposer.tsx`, `apps/web/src/components/clerk/MobileClientsUserProfilePage.tsx`, `pnpm-lock.yaml`. At about 300 upstream commits/week, expect daily conflicts in ChatView/Sidebar/ChatComposer/settings unless the footprint shrinks.

### Extension seams that exist upstream

- **Routes**: TanStack file routes (`apps/web/src/routes/*`, plugin in `apps/web/vite.config.ts:173`). New route files are additive and conflict-free. `routeTree.gen.ts` is generated, so on conflict take either side and regenerate. Mark it `merge=ours` in `.gitattributes` or regenerate in the sync job.
- **Sidebar**: `AppSidebarLayout.tsx` already switches `LegacyThreadSidebar` vs `ThreadSidebar` on `legacySidebarEnabled` (`contracts/settings.ts:462`, `hooks/useSettings.ts:378`). That is the one place for a fork sidebar (`SidebarViews`). Keep `Sidebar.tsx` untouched and render the fork tree from a separate module.
- **Settings**: `SettingsSidebarNav.tsx` + `SettingsPanels.tsx` + `settingsSearch.ts` are static lists, so expect a 1–3 line hook per section. Put fork panels in their own files.
- **Providers**: driver/adapter registries (`apps/server/src/provider/Layers/ProviderAdapterRegistry.ts`, `ProviderRegistry.ts`, `builtInDrivers.ts`). Hermes added a whole provider with a registration line.
- **Branding**: `apps/web/src/branding.ts` already has `APP_BASE_NAME` + `injectedDesktopAppBranding`. Upstream still hardcodes "T3 Code" in roughly 150 places.
- **Build-time identity**: `T3CODE_DESKTOP_UPDATE_REPOSITORY`, `T3CODE_DESKTOP_APP_USER_MODEL_ID`, `T3CODE_HOME`, `T3CODE_RELEASE_BASE_URL`, `T3CODE_POSTHOG_KEY/HOST`, `T3CODE_TELEMETRY_ENABLED`, `T3CODE_IOS_PERSONAL_TEAM*`. Partial but useful.
- No generic feature-flag system exists beyond settings booleans.

### Recommended strategy

1. **Get the work into git on a fork branch now**, then structure it as: `main` = upstream + a thin, durable fork layer; feature work on short branches merged into fork `main`.
2. **Merge, never rebase** fork `main` (public history; hermes reached the same conclusion). Keep upstream commits verbatim.
3. **Isolate fork code**: new modules under fork-owned paths (`components/sidebar/*`, `routes/*`, `components/{spaces,team,…}`). Upstream hot files get at most one import + one render or registration line, each marked with a `// signalbox:` comment so conflicts are obvious and greppable.
4. **Kill the branding diff**: one identity module (`packages/shared/src/productIdentity.ts` or build-time injected) for display name, app ID, home dir, port, scheme, release repo, npm name, PostHog key. Replace literals with `APP_BASE_NAME`. That removes 80 conflict-prone files.
5. **Upstream-able PRs** (shrink the fork for good, and upstream values forks):
   - replace hardcoded "T3 Code" strings with `APP_BASE_NAME`/desktop branding
   - derive `CLI_RELEASE_REPOSITORY` and the release-history URL from the same build-time repo as `T3CODE_DESKTOP_UPDATE_REPOSITORY`
   - build-time-injectable product identity (appId, userData dir, home dir, scheme) so forks coexist
   - PostHog key injectable at build time, telemetry off when no key is configured
   - `if: github.repository == 'pingdotgg/t3code'` guards on infra/deploy workflows and cron jobs
   - optional mac passkey provisioning when signing (fork Developer-ID builds without Clerk)
   - self-signed macOS signing fallback (port of hermes #64)
6. **Automation**: replace the paused local Codex heartbeat with a GitHub Action `sync-upstream.yml` (fork-only guard, GitHub-hosted runner). Every 3–6h it fetches upstream, `git merge-tree` checks, opens or auto-merges a sync PR when clean, runs focused CI (typecheck + affected tests), files an `upstream-sync-conflict` issue on conflict, and optionally dispatches the fork nightly after a clean merge. Add a CI job on fork PRs: "does this branch still merge cleanly with upstream/main?" (`git merge-tree --write-tree`), so new fork edits that touch hot files get flagged before they land.
7. Prefer following upstream nightlies (hermes #60): build fork nightlies only when fork main contains upstream's latest nightly commit, so fork versions ride upstream-tested commits.

---

## 3. Telemetry and analytics

- **PostHog (product analytics)**, server-side only: `apps/server/src/telemetry/AnalyticsService.ts`, identity `apps/server/src/telemetry/Identify.ts` (hashed provider account ID, else installation ID). The default key is hardcoded: `phc_XOWci4oZP4VvLiEyrFqkFjP4CZn55mjYYBMREK5Wd6m` → `https://us.i.posthog.com`. Overrides: `T3CODE_POSTHOG_KEY`, `T3CODE_POSTHOG_HOST`, `T3CODE_TELEMETRY_ENABLED=false`. **A Signalbox build today reports usage into upstream's PostHog project.**
  - Events: `server.boot.heartbeat`, `client.connected`, `client.thread.started`, `client.turn.requested` (`ws.ts`), `provider.session.{started,stopped,recovered}`, `provider.turn.{attempted,sent,rejected,interrupted,completed}`, `provider.runtime_mode.changed`, `provider.thread.compacted`, `provider.request.responded`, `provider.conversation.rolled_back`, `provider.sessions.stopped_all` (`ProviderService.ts`), plus `CodexChatGptAuth.ts`. Properties are provider/model/effort/mode/result/duration/token totals plus client `surface`/os. No prompts or content (`docs/internals/product-analytics.md`, `docs/user/telemetry.md`).
  - Clients don't load a PostHog SDK. Client dimensions ride the WebSocket connection.
- **OpenTelemetry**: server OTLP traces/metrics/logs export is opt-in (`apps/server/src/config.ts` `otlp*`, `apps/server/src/observability/Layers/Observability.ts`). Local NDJSON trace file is always on (`<home>/userdata/logs/server.trace.ndjson`, `t3 trace summary`). Web client tracing goes to the local server (`apps/web/src/observability/clientTracing.ts`) and, with T3 Connect, to Axiom via relay config baked at release (`T3CODE_RELAY_CLIENT_OTLP_TRACES_*`). Docs: `docs/operations/observability.md`, `relay-observability.md`.
- **Sentry**: none (grep hits are false positives like `windowsEntryPath`).
- Desktop `DesktopTelemetryPublisher` is host resource/power telemetry over IPC to the local server, not external.

**What the fork needs:** create a Signalbox PostHog project and change the default key (one line in `AnalyticsService.ts`, 3 upstream commits/60d, low conflict). Or keep the upstream default overridden at build/runtime and default-off until set; hermes #70 did the former. Reuse the existing `analytics.record(...)` service for fork features (e.g. `signalbox.space.opened`) rather than adding a browser SDK, which keeps the privacy boundary. Update `docs/user/telemetry.md` to name the fork's project. If you want error tracking, add Sentry in fork-only modules or use OTLP to Grafana/Axiom with the existing config.
