# Upstream sync and the rebrand codemod

Upstream T3 Code is a source, not a branch ([AGENTS.md](../../AGENTS.md#upstream-t3-code)). We
merge it while that stays cheap and port specific changes where it doesn't. Fork code never bends
its design to keep merges clean.

## Merge or port

Each sync is worth what it brings minus what its conflicts cost.

- **It brings** upstream fixes and improvements to code we still share: provider adapters (the
  runner reuses upstream's Claude and Codex adapters), contracts, bug and performance fixes. Commits
  that only touch code we replaced bring nothing.
- **Its conflicts cost** the files that need real resolution. A line we only renamed is mechanical:
  take upstream's side and let the codemod rename it again. A file we restructured or replaced is
  real work, and it comes back on every sync that touches it.

Merge when most conflicts are mechanical, or when the real ones are worth what the sync brings.
Otherwise port: keep our side of the code we replaced, and bring over only the upstream changes we
want, by hand or with `git cherry-pick -x <sha>` on a branch off `main`. A file that conflicts on
sync after sync is the signal to switch that area to porting for good.

The eight recorded conflict issues through #526, checked on 2026-10-18, show recurring conflicts in
`apps/server/src/mcp/toolkits/orchestrator/tools.ts` (six issues), `docs/user/install.md` (five), and
`apps/mobile/src/features/home/HomeHeader.tsx` (three). See #115, #168, #181, #194, #196, #204,
#209, and #526 for the per-sync file lists. Use these counts to choose where to inspect first, then
make the merge-or-port call from the current conflict diff. Keep each sync's details in its issue or
PR, and refresh these counts when new conflict history changes the ranking.

The rule for persistence migrations in AGENTS.md lasts as long as we merge upstream's
`apps/server/src/persistence`. Stopping upstream merges altogether is Yannic's call; flag it rather
than skipping syncs quietly.

## What renames what

Internal names such as `@t3tools/*` packages, `T3CODE_*` env vars, symbol and file names, lint rule
ids and the `t3.json` format are still upstream's. Rename one only as part of a real change. Where code
we still merge from upstream uses the old name, extend the codemod in the same PR so syncs keep
renaming it. Protocol
paths such as `/.well-known/t3/environment` and the `t3/<hex>` worktree branch format are wire
contracts with other servers and clients, so they keep upstream's names.

- `scripts/rebrand/rebrand.ts` rewrites user-facing text in source: product names, CLI commands,
  the npx package, install URLs, `signalbox://` links, and data paths in docs. In JS/TS it only
  touches string literals, template text, and JSX text, and skips comments and test titles.
  Exclusions and external contracts are listed at the top of the file.
- App identity lives at fixed definition sites, edited by hand: app and bundle ids, data dirs,
  ports, URL schemes, Linux and GNOME names, the CLI executable and archive names
  (`packages/shared/src/cliRelease.ts`), the npm launcher's package, bin, data home and archive
  names (`scripts/build-npm-launcher.ts`, `scripts/npm-launcher/t3.mjs`, and the npm install
  check in `apps/server/src/cli/invocation.ts`), service labels, and
  `apps/server/src/cli/triagePrompt.ts`. `git log` on the identity and CLI commits lists them.

## Automated sync

`.github/workflows/upstream-sync.yml` runs every four hours and on demand (Actions > Upstream Sync >
Run workflow). When upstream has new commits and they merge cleanly, it rebuilds the
`upstream-sync` branch from `main`, merges `upstream/main`, runs the post-merge steps below, and
opens one PR. Merge it with a merge commit. Never squash or rebase a sync PR: that drops
upstream's history and turns the next sync into conflicts. The workflow force-pushes
`upstream-sync` on every clean run, so never push your own work to that branch.

When the merge conflicts, or GitHub refuses the push, the workflow opens or updates one issue
labelled `upstream-sync-conflict`. For a conflict, it lists the conflicting files next to the number
of upstream commits and a link to their diff, which is what you need to decide between merging and
porting above. The next clean sync closes the issue.

Every PR also runs the Upstream Merge job in Signalbox CI. It reports the files a PR makes conflict
with `upstream/main`, as warnings that never fail the PR: they are the cost the next sync pays. On
a PR that merges upstream, it fails when a `signalbox:` hook line from `main` is gone, unless
upstream deleted the hook's file. A hook that moved with upstream's code counts as kept. When that
job passes on an upstream merge, the Upstream Sync check passes too, and the signalbox folder's
Merge gate trusts it to merge the sync PR on its own.

GitHub refuses pushes from `GITHUB_TOKEN` that change `.github/workflows`, and upstream changes
them often. The `UPSTREAM_SYNC_TOKEN` secret, a fine-grained token for this repository with
Contents, Workflows, Pull requests, and Issues write access, lets the sync push those. Without it
the sync still lands merges that leave workflow files alone.

## Merging upstream by hand

1. Merge `upstream/main` into a branch off `main`. Don't use `upstream-sync`.
2. Resolve conflicts. Where we only renamed, take upstream's side, then let the codemod rename it
   again. Taking ours would drop upstream's edit.

   ```sh
   git checkout --theirs -- <file>
   ```

   Keep ours wherever we changed meaning: code we restructured or replaced, the identity sites
   above, `// signalbox:` hook lines, and fork-owned docs (`AGENTS.md`, and `docs/user/` pages that
   describe how to get Signalbox). Port the part of upstream's change we want into our code, or
   leave it out. When upstream refactors a hooked file we still share, re-apply the hook to
   upstream's new code instead of reverting it.

3. Run the post-merge steps: install, rename whatever upstream added, format, and regenerate
   `.github/triage/PLAYBOOK.md` and `apps/web/src/routeTree.gen.ts`:

   ```sh
   node scripts/upstream-sync/sync.ts --post-merge
   ```

   This prunes fixed module-boundary baseline entries once the merge is committed. After
   resolving conflicts and committing the merge, rerun
   `node scripts/boundaries/check.mjs --write-baseline` and commit any baseline changes.
   New fork violations still fail CI and must be fixed before merging the PR.

4. Grep for new identity values upstream may have added (`com.t3tools`, `t3code://`, `~/.t3`,
   `3773`, `"t3"` executables) and route them to Signalbox's. The automated sync can't do this
   one.
5. Open a PR and merge it with a merge commit.

Signalbox CI runs `node scripts/rebrand/rebrand.ts --check`, so a merge that skips step 3 fails.
The codemod is idempotent: a second run changes nothing.
