# ts-rust WASI artifact

This recipe builds the `npm/wasm` module from the pristine ts-rust revision in
`provenance.json`. It verifies the codeload archive and the upstream lockfile
and build inputs, then invokes that revision's `scripts/wasm/build.sh` without
patching compiler sources. Rustup and Cargo use caches under the supplied
scratch directory, and Cargo resolves the locked crates there.

Run it through the caller's `heavy-slot` wrapper, passing an issue-local scratch
directory and output path:

```sh
bash apps/cloud/infra/kernelPrograms/tsc-rs/build.sh \
  .t3/1073/tsc-rs-build .t3/1073/tsc-rs.wasm
```

It pins Rust 1.96.0, uses two Cargo jobs, the upstream `wasm` profile, and
`WASM_OPT=none`, and clears ambient compiler/profile flag overrides. The official
upstream script selects its capped Cargo runner only on hosts with a systemd
user session. On macOS, the heavy-slot caller and two Cargo jobs limit
scheduling; macOS does not enforce a cgroup memory cap.

The build writes a manifest and a `<artifact>.notices/` directory beside the
artifact. The notices directory contains the upstream NOTICE and referenced
license texts; keep it with the artifact when redistributing. The manifest
records their hashes with the source, toolchain, artifact hash, imports, and
exports. The packager accepts only the artifact size and SHA-256 recorded in
`provenance.json` and packages it as a static WASM module, so the Worker does
not compile bytes at runtime.

The source tree's `LICENSE` is MIT. The upstream `npm/wasm` package declares
`MIT AND Apache-2.0`; `NOTICE.md` identifies bundled TypeScript, Go, Unicode,
and LSP material and links to its retained license texts.

Package the child-Worker fixture and run it in local workerd:

```sh
node apps/cloud/infra/kernelPrograms/tsc-rs/prepare.ts <fixture-directory> <artifact.wasm>
node apps/cloud/infra/isolateProbe/measure.ts --fixture <fixture-directory> --output <evidence.json>
```

The fixture checks a good project, a real type error, the corrected project and
emitted files, then repeats them in the same facet. Every compiler invocation
gets a fresh child and uses the facet's files and descriptors through RPC.
The separate large-workload route checks selection of an explicitly configured
machine port and does not execute a machine command. The default table stays
empty. Workspace bytes are measured input for that rule, not a universal
prediction of compiler memory.

Use the same fixture on an owned deployed probe to establish the actual isolate
memory limit. Local workerd does not establish that it fits in a deployed DO.
