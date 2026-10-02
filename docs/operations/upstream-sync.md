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

## After merging upstream

1. Merge `upstream/main` into a branch off `main`.
2. Resolve conflicts. Most are lines upstream changed that we renamed. For those, take upstream's
   side, then let the codemod rename it again. Taking ours would drop upstream's edit.

   ```sh
   git checkout --theirs -- <file>
   ```

   Keep ours only where we changed meaning, not wording: the identity sites above.

3. Rename whatever upstream added, then format:

   ```sh
   node scripts/rebrand/rebrand.ts
   vp fmt
   ```

4. If `apps/server/src/cli/triagePrompt.ts` changed, regenerate the playbook it must match:

   ```sh
   node -e 'import("./apps/server/src/cli/triagePrompt.ts").then((m) => require("node:fs").writeFileSync(".github/triage/PLAYBOOK.md", m.TRIAGE_PLAYBOOK))'
   ```

5. Grep for new identity values upstream may have added (`com.t3tools`, `t3code://`, `~/.t3`,
   `3773`, `"t3"` executables) and route them to Signalbox's.

Signalbox CI runs `node scripts/rebrand/rebrand.ts --check`, so a merge that skips step 3 fails.
The codemod is idempotent: a second run changes nothing.
