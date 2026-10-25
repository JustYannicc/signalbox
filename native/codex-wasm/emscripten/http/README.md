# Emscripten HTTP compile carrier

`prepare_emscripten_http(cache, sources)` archives the fixed AgentOS commit in
`dependencies/staging.py`. It copies only `reqwest-shim`, `wasi-http` and
`wasi-ext`, preserving their relative paths under `toolchain/`. It applies the
same four HTTP patch sections as `dependencies/patches/wasi-deps.patch`, with
only their path prefixes changed. The original checkouts stay untouched.

The returned map replaces reqwest 0.12.28. It leaves reqwest 0.13 used by rmcp
alone. A cache stage records the source pin, patch/import-library identity and
all copied file hashes. Changed files, symlinks, package versions or relative
dependencies fail preparation instead of reusing a changed carrier.

This preserves the existing compile carrier's limitations. TLS configuration,
custom roots/identities, proxy settings, redirect policies, cookies and cookie
providers are accepted but ignored. The carrier uses its HTTP/1.1 client and
collects a request body before sending it. Its async response reader yields raw
chunks, but the blocking wrapper polls with a sleep loop. Compression, DNS and
HTTP/2 feature flags do not provide the corresponding reqwest behavior. These
are existing limitations, not evidence of a working provider transport.

`imports.js` declares the seven `host_net` functions used by this client:
`net_socket`, `net_connect`, `net_send`, `net_recv`, `net_close`,
`net_tls_connect` and `net_setsockopt`. Each declaration throws if called. The
loader must supply a real request-owned host with the existing shared kernel
contract. There is no second networking ABI and no fake HTTP response. The
AgentOS import arguments and errno values still need translation by that host;
Emscripten libc socket descriptors must not be confused with AgentOS handles.

Pass this library with `--js-library` through `CARGO_ENCODED_RUSTFLAGS` in
addition to the reactor library. Keep undefined-symbol errors enabled. Only
imports explicitly selected by the host may suspend through JSPI; declaring a
symbol does not implement its I/O or grant network access.

`probes/run.py --output <fresh-directory> --graph <full-engine-cargo-graph.json>`
uses the existing private Rust install, SDK, reactor helper and HTTP carrier.
Run it under heavy-slot. It checks and links a program with the reqwest 0.12
features requested by Codex, inventories the actual WASM imports, and verifies
that a missing HTTP host rejects before guest execution. It sends no HTTP
request and proves no TLS, streaming, cancellation or full Codex turn behavior.
