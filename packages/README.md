# Workspace modules

Import another workspace by its package name and an exported subpath. Its
`package.json` `exports` defines its interface, including wildcard exports.
Relative imports across workspace directories bypass that interface and fail
`vp run lint:boundaries`. Files inside one workspace can use relative imports.

Tests in packages with exports exercise those exports, even when the test sits
next to the implementation. Test fixtures stay private to tests. Expose several
small entry points when needed; avoid a barrel that re-exports the whole subtree.
Apps without exports keep their internal test conventions.

Cloud modules use [root-file entry points](../apps/cloud/src/README.md).
Cycles, including type-only cycles, are checked across the workspace graph.

Severity follows the importing file's presence in `upstream/main`, the ref used
by Upstream Merge: present means warning, absent means fork-owned and error.
A modified upstream file still warns, including its `signalbox:` hook lines.
A cycle involving any fork-only file errors. Fetch the ref before running locally:

```sh
git fetch --no-tags https://github.com/pingdotgg/t3code.git main:refs/remotes/upstream/main
vp run lint:boundaries
```

The initial fork violations are recorded in `scripts/boundaries/baseline.json`.
Fix leaks as PRs touch them; remove their entries. CI compares the list with the
PR base and rejects additions. `node scripts/boundaries/check.mjs --write-baseline`
can prune it after fixes, but cannot enlarge the list. The module map and current
platform leaks live on [#840](https://github.com/JustYannicc/signalbox/issues/840).
