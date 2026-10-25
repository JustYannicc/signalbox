Enriched Markdown extends the [`fork/t3-mobile` branch](https://github.com/pingdotgg/enriched-markdown/tree/fork/t3-mobile). File/skill link recognition, back navigation from horizontal blocks, table-image presses, and code-block headers use upstream implementations. The fork adds clipboard metadata, parsed asset manifests, signed image source resolution, React media slots, development-host autolinks, and source-owned text selection.

The `t3.16` tarball is built from reachable base `9fe6c6d23e8544376bcc024bc50a8653e562e745` plus the adjacent complete source patch. Its `t3-fork.json` records that base, the patch's SHA-256, the upstream base, and the package version. The patch contains the renderer changes and packaging script needed to rebuild it.

To reconstruct it, start in this directory and use a fresh checkout:

```sh
shasum -a 256 -c react-native-enriched-markdown-1.2.0-t3.16.patch.sha256
renderer_patch="$PWD/react-native-enriched-markdown-1.2.0-t3.16.patch"
renderer_output="$PWD/rebuilt"
git clone https://github.com/pingdotgg/enriched-markdown enriched-markdown-source
cd enriched-markdown-source
git checkout --detach 9fe6c6d23e8544376bcc024bc50a8653e562e745
git apply --check "$renderer_patch"
git apply "$renderer_patch"
git add -A
git commit -m 'Apply the Signalbox t3.16 renderer patch'
node .yarn/releases/yarn-4.11.0.cjs install --immutable
node .yarn/releases/yarn-4.11.0.cjs workspace react-native-enriched-markdown prepare
node scripts/pack-t3.mjs "$renderer_output" --source-patch "$renderer_patch"
```

Compare the extracted package files and their modes, including generated native APIs and licensing files. Archive timestamps can differ. The packer requires a clean committed tree and checks that the supplied patch equals the complete base-to-HEAD diff.

For a replacement, bump the fork package version, commit its changes, export the complete patch with `git diff --no-ext-diff --no-textconv --binary --full-index 9fe6c6d23e8544376bcc024bc50a8653e562e745 HEAD`, and record its SHA-256. Run the pinned Yarn install and prepare commands, then pack with that patch. Check in the patch, checksum, and replacement tarball; update `apps/mobile/package.json` and `pnpm-workspace.yaml`'s `allowBuilds`, and run `vp i` to update the lockfile.

Native clients need rebuilding when this dependency changes. The exact Find conversation walks must use clients rebuilt against this artifact on both iOS and Android.
