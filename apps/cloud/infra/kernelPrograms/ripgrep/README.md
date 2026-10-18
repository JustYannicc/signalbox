# Ripgrep WASI proof artifact

`bin/rg.wasm` is generated locally and ignored by Git. The proof preparation script reads that artifact and checks its pinned size, SHA-256, and WASI imports; do not commit the binary.

To rebuild it from the pinned upstream sources, install wasi-sdk 24 and set `WASI_SDK_ROOT` to that installation, then run:

```sh
WASI_SDK_ROOT=/path/to/wasi-sdk apps/cloud/infra/kernelPrograms/ripgrep/build-rg-stock-std.sh
```

The script uses isolated Rustup and Cargo homes under its ignored `.build/` directory. It fetches the ripgrep crate by its recorded checksum, checks out the pinned wasi-libc commit, fetches and checks the AgentOS patches, builds the patched libc archives, installs the pinned Rust nightly into the isolated Rustup home, and builds with stock Rust standard libraries plus the wasi-libc archives. The final WASM must match the current artifact pin before it is staged in `bin/`.

Prepare a facet package after the build with:

```sh
node --experimental-strip-types apps/cloud/infra/kernelPrograms/ripgrep/prepare.ts /path/to/output
```

For an official ripgrep update, change the source version and checksum in `provenance.json`, review the pinned Cargo lock and AgentOS patch set, rebuild, then update the artifact pin and import list in `prepare.ts` and `probe-source.ts`. Run the pure-WASI check and hosted fixture proof before updating the recorded provenance. `build.scriptSha256` records the script used for the existing artifact; `rebuildRecipe` records this portable checked-in recipe separately.
