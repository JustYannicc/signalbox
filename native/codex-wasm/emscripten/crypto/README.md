# Ring on Emscripten

Ring 0.17.14 builds on Emscripten but excludes `SystemRandom`'s `SecureRandom`
implementation there. Rustls's Ring provider then fails to compile. The copied
crate patch adds only `target_os = "emscripten"` to the wasm32 branch that calls
Ring's existing `getrandom::getrandom`. It changes no algorithm, error mapping,
features, or other target branches.

`prepare_emscripten_crypto(cache, sources)` returns a `ring` path for the wrapper's
`[patch.crates-io]`. It downloads an independently checksum-verified release
archive, patches a temporary copy, and publishes it by rename. Its `.ready`
identity includes the archive pin and patch bytes; reuse checks the file
inventory. Original source checkouts and Cargo registry sources are never patched.

## Why this entropy source

Checked upstream before choosing the patch:

- crates.io reports 0.17.14 as Ring's latest stable release. Its archive SHA-256 is
  `a4689e6c2294d81e88dc6261c768b63bc4fcdb852be6d1352498b114f61383b7`, also in
  Codex 0.162.1's lockfile.
- [Ring upstream rand.rs at 840167e18e4fa837eb48de46500454a616a15a6e](https://github.com/briansmith/ring/blob/840167e18e4fa837eb48de46500454a616a15a6e/src/rand.rs)
  still omits Emscripten. Updating to that source would not fix this cfg.
- [getrandom 0.2.17](https://docs.rs/crate/getrandom/0.2.17/source/src/lib.rs)
  explicitly supports Emscripten through `getentropy`. Its
  [implementation](https://docs.rs/crate/getrandom/0.2.17/source/src/getentropy.rs)
  calls libc in chunks of at most 256 bytes and propagates nonzero results.
  Archive SHA-256 from the pinned Codex lockfile is
  `ff2abc00be7fca6ebc474524697ae276ad847ad0a6b3faa4bcb027e9a4614ad0`.
- libc 0.2.186 declares `getentropy` in its Emscripten module.
- [Emscripten 4.0.10 getentropy.c](https://github.com/emscripten-core/emscripten/blob/4.0.10/system/lib/libc/musl/src/misc/getentropy.c)
  calls `__wasi_random_get` and translates errors with `__wasi_syscall_ret`.
  The installed SDK file SHA-256 is
  `b8da175245b86fff7aa00e3146451b4a89626141d9ae42dd81e735160c3c894c`.
- [Emscripten 4.0.10 libwasi.js](https://github.com/emscripten-core/emscripten/blob/4.0.10/src/lib/libwasi.js)
  implements `random_get` with `randomFill`, which calls
  `crypto.getRandomValues` for the wrapper's `ENVIRONMENT=web,worker`,
  `SHARED_MEMORY=0` flags. The installed file SHA-256 is
  `b314c4b9800b37906c22f87b1dfe5f41a15399361bfb0ef83ab8b1ff229470fd`.

## Focused proof

Run `probes/run.py` under `heavy-slot`, with a fresh `--output` directory and the
parent build's `--graph` metadata. It requires the already installed private Rust
and SDK 4.0.10. It never prepares WASI or installs another toolchain.

The probe first checks an unpatched Ring/Rustls dependency set and requires the
missing `SecureRandom` failure. It then uses the patch map, checks the activated
Ring/getrandom/libc versions and features against the parent graph, checks and
links a small binary, and runs it through the unchanged static-module loader.
Rustls enables its Ring provider only; its AWS-LC provider and the rest of Codex
are outside this probe.

The synthetic Node host compiles fixture bytes before invoking the loader, then
rejects dynamic compile/instantiate/fetch APIs. Its Web Crypto observer delegates
to Node's actual `crypto.getRandomValues` and checks call sizes during Ring and
Rustls RNG operations. An injected Web Crypto exception must reject the run
before the guest reports success. Emscripten propagates that exception; it does
not translate a throwing Web Crypto implementation into a Rust `Err`.

This verifies the entropy call boundary and visible failure, not entropy quality,
a TLS handshake, a real worker/browser host, or a complete Codex turn.
