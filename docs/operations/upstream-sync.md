# Upstream sync and the rebrand codemod

Signalbox renames what users see, type, or install. Code identifiers stay upstream's so upstream
patches apply cleanly: `@t3tools/*` packages, `T3CODE_*` env vars, symbol and file names, lint rule
ids, the `t3.json` format, protocol paths such as `/.well-known/t3/environment`, and the
`t3code/<hex>` worktree branch format.

## What renames what

- `scripts/rebrand/rebrand.ts` rewrites user-facing text in source: product names, CLI commands,
  the npx package, install URLs, `signalbox://` links, and data paths in docs. In JS/TS it only
  touches string literals, template text, and JSX text, and skips comments and test titles.
  Exclusions and external contracts are listed at the top of the file.
- App identity lives at fixed definition sites, edited by hand: app and bundle ids, data dirs,
  ports, URL schemes, Linux and GNOME names, the CLI executable and archive names
  (`packages/shared/src/cliRelease.ts`), npm names (`scripts/build-npm-platform-packages.ts`),
  service labels, and `apps/server/src/cli/triagePrompt.ts`. `git log` on the identity and CLI
  commits lists them.

## Automated sync

`.github/workflows/upstream-sync.yml` runs every four hours and on demand (Actions > Upstream Sync >
Run workflow). When upstream has new commits and they merge cleanly, it rebuilds the
`upstream-sync` branch from `main`, merges `upstream/main`, runs the post-merge steps below, and
opens one PR. It never merges itself: a person reviews what upstream changed and merges it with a
merge commit. Never squash or rebase a sync PR: that drops upstream's history and turns the next
sync into conflicts. The workflow force-pushes
`upstream-sync` on every clean run, so never push your own work to that branch.

Every PR also runs the Upstream Merge job in Signalbox CI. It fails when the PR adds files that
conflict with `upstream/main`; conflicts already on `main` are left to the sync.

When the merge conflicts, or GitHub refuses the push, the workflow opens or updates one issue
labelled `upstream-sync-conflict` with the files and the upstream commit. Resolve it by hand below.
The next clean sync closes the issue.

GitHub refuses pushes from `GITHUB_TOKEN` that change `.github/workflows`, and upstream changes
them often. The `UPSTREAM_SYNC_TOKEN` secret, a fine-grained token for this repository with
Contents, Workflows, Pull requests, and Issues write access, lets the sync push those. Without it
the sync still lands merges that leave workflow files alone.

## Merging upstream by hand

1. Merge `upstream/main` into a branch off `main`. Don't use `upstream-sync`.
2. Resolve conflicts. Most are lines upstream changed that we renamed. For those, take upstream's
   side, then let the codemod rename it again. Taking ours would drop upstream's edit.

   ```sh
   git checkout --theirs -- <file>
   ```

   Keep ours only where we changed meaning, not wording: the identity sites above.

3. Run the post-merge steps: install, rename whatever upstream added, format, and regenerate
   `.github/triage/PLAYBOOK.md` and `apps/web/src/routeTree.gen.ts`:

   ```sh
   node scripts/upstream-sync/sync.ts --post-merge
   ```

4. Grep for new identity values upstream may have added (`com.t3tools`, `t3code://`, `~/.t3`,
   `3773`, `"t3"` executables) and route them to Signalbox's. The automated sync can't do this
   one.
5. Open a PR and merge it with a merge commit.

Signalbox CI runs `node scripts/rebrand/rebrand.ts --check`, so a merge that skips step 3 fails.
The codemod is idempotent: a second run changes nothing.
