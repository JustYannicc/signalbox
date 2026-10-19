# Ripgrep WASI proof artifact

`bin/rg.wasm` is generated locally and ignored by Git. The proof preparation script reads that artifact and checks its pinned size, SHA-256, and WASI imports; do not commit the binary.

To build the current source recipe, install the official wasi-sdk 25 archive containing the pinned clang 19.1.5 and set `WASI_SDK_ROOT` to that installation, then run:

```sh
WASI_SDK_ROOT=/path/to/wasi-sdk apps/cloud/infra/kernelPrograms/ripgrep/build-rg-stock-std.sh
```

The pinned artifact was built with the official wasi-sdk 25 arm64 macOS distribution. Its clang 19.1.5 matches LLVM commit `ab4b5a2db582958af1ee308a790cfdb42bd24720`. Official wasi-sdk 24 contains clang 18.1.2 and fails that check. `toolchain.wasiSdk.archive` records the matching archive.

The script uses isolated Rustup and Cargo homes under its ignored `.build/` directory. It fetches the ripgrep crate by its recorded checksum, overlays the separately pinned `Cargo.lock`, unpacks the checksum-pinned wasi-libc commit archive, fetches and checks the AgentOS patches, verifies and applies the local source patches, builds the patched libc archives, installs the pinned Rust nightly into the isolated Rustup home, and builds with stock Rust standard libraries plus the wasi-libc archives. Rust source paths under the per-run directory map to `/signalbox/ripgrep-build`; Git discovery stops there, so a containing Signalbox worktree cannot supply a version hash.

The checked artifact pin is 2208556 bytes with SHA-256 `791b862a433f1a5a9b6a7ce982546d33f4146dcb019dba5da1e78be7bffc7ca7`. It includes `patches/0001-probe-sort-timestamps-on-search-roots.patch`. Normal rebuilds must match this pin before they replace `bin/rg.wasm`. When preparing a future source or recipe change, build candidates outside the package with `RIPGREP_EXPECT_ARTIFACT_SHA=discover`:

```sh
WASI_SDK_ROOT=/path/to/wasi-sdk \
RIPGREP_BUILD_ROOT=/path/to/fresh/build-root \
RIPGREP_ARTIFACT_OUTPUT=/path/to/candidate/rg.wasm \
RIPGREP_EXPECT_ARTIFACT_SHA=discover \
apps/cloud/infra/kernelPrograms/ripgrep/build-rg-stock-std.sh
```

That mode writes a sibling artifact manifest with the actual hash. Repeat it from a different fresh `RIPGREP_BUILD_ROOT`, this time setting `RIPGREP_EXPECT_ARTIFACT_SHA` and `RIPGREP_EXPECT_ARTIFACT_BYTES` to the first build's values. Candidate builds require an external `RIPGREP_ARTIFACT_OUTPUT`, so they cannot replace the packaged artifact. Update the pin only after both builds match and the focused candidate proof passes.

The local timestamp-sort patch checks metadata on each resolved filesystem search root. Relative paths use ripgrep's existing cwd handling, absolute paths stay absolute, and every non-stdin operand must support the requested timestamp. Stdin operands need no filesystem timestamp check. Root metadata errors remain fatal and name the failed root; ripgrep's per-entry timestamp sorting stays unchanged.

Run the focused artifact regression against a frozen Signalbox host source tree:

```sh
node --experimental-wasm-jspi \
  apps/cloud/infra/kernelPrograms/ripgrep/verify-sort.mjs \
  /path/to/candidate/rg.wasm /path/to/frozen/signalbox-source candidate
```

The helper uses the public Node child-process bridge with in-memory SQL storage and uid 1000. It checks the exact Glob and Grep arguments from both a normal cwd and a procfd cwd, ascending and descending timestamp order, relative and absolute roots, multiple roots, missing-root errors, and stdin. It removes the real directory descriptor `PATH_FILESTAT_GET` right for its negative controls. Pass `baseline` instead of `candidate` to assert the current artifact's unsupported-sort failure. This Node proof does not establish native workerd or deployed behavior.

Prepare a facet package after the build with:

```sh
node --experimental-strip-types apps/cloud/infra/kernelPrograms/ripgrep/prepare.ts /path/to/output
```

Build the SQL-backed sort proof fixture with the pinned artifact and current kernel sources using:

```sh
node --experimental-strip-types apps/cloud/infra/nodeProof/prepareRipgrepSort.ts /path/to/output
```

The fixture statically imports the WASM and exercises the real child-process bridge against persistent facet storage. It returns structured results for `/proof` and `/proof-again`; native and deployed proof still run in their respective environments.

For an official ripgrep update, change the source version and checksum in `provenance.json`, review the pinned Cargo lock and AgentOS patch set, then rebuild twice. Update the artifact pin in `KernelRipgrepProgram.ts` and review the WASI import checks in the preparation scripts. Run the public Node regression and the sort fixture in local workerd and a deployed facet before updating the recorded provenance. `build.scriptSha256` records the script used for the existing artifact; `rebuildRecipe` records this portable checked-in recipe separately.
