# Ripgrep WASI proof artifact

`bin/rg.wasm` is generated locally and ignored by Git. The proof preparation script reads that artifact and checks its pinned size, SHA-256, and WASI imports; do not commit the binary.

To rebuild it from the pinned upstream sources, install wasi-sdk 24 and set `WASI_SDK_ROOT` to that installation, then run:

```sh
WASI_SDK_ROOT=/path/to/wasi-sdk apps/cloud/infra/kernelPrograms/ripgrep/build-rg-stock-std.sh
```

The script uses isolated Rustup and Cargo homes under its ignored `.build/` directory. It fetches the ripgrep crate by its recorded checksum, overlays the separately pinned `Cargo.lock`, checks out the pinned wasi-libc commit, fetches and checks the AgentOS patches, builds the patched libc archives, installs the pinned Rust nightly into the isolated Rustup home, and builds with stock Rust standard libraries plus the wasi-libc archives. Rust source paths under the per-run directory map to `/signalbox/ripgrep-build`; Git discovery stops there, so a containing Signalbox worktree cannot supply a version hash.

Normal rebuilds must match the checked artifact pin before they replace `bin/rg.wasm`. To produce an unpinned candidate without touching that file, pass both an external output path and `RIPGREP_EXPECT_ARTIFACT_SHA=discover`:

```sh
WASI_SDK_ROOT=/path/to/wasi-sdk \
RIPGREP_BUILD_ROOT=/path/to/fresh/build-root \
RIPGREP_ARTIFACT_OUTPUT=/path/to/candidate/rg.wasm \
RIPGREP_EXPECT_ARTIFACT_SHA=discover \
apps/cloud/infra/kernelPrograms/ripgrep/build-rg-stock-std.sh
```

That mode writes a sibling artifact manifest with the actual hash. Repeat it from a different fresh `RIPGREP_BUILD_ROOT`, this time setting `RIPGREP_EXPECT_ARTIFACT_SHA` and `RIPGREP_EXPECT_ARTIFACT_BYTES` to the first build's values. A noncurrent pin also requires an explicit external `RIPGREP_ARTIFACT_OUTPUT`, so candidate builds cannot replace the packaged artifact. Only update the packaged artifact pin after the two output hashes match and the candidate proof passes.

Prepare a facet package after the build with:

```sh
node --experimental-strip-types apps/cloud/infra/kernelPrograms/ripgrep/prepare.ts /path/to/output
```

For an official ripgrep update, change the source version and checksum in `provenance.json`, review the pinned Cargo lock and AgentOS patch set, rebuild, then update the artifact pin and import list in `prepare.ts` and `probe-source.ts`. Run the pure-WASI check and hosted fixture proof before updating the recorded provenance. `build.scriptSha256` records the script used for the existing artifact; `rebuildRecipe` records this portable checked-in recipe separately.
