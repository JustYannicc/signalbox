# Codex wasm wrapper

Build an official Codex release for WASI isolates. `upstream.json` pins its stable tag
and Git commit, the Rust toolchain, and the reusable agentOS inputs. The input
checkout is hashed before and after every build. Builds never run inside it.

Codex currently has missing WASI platform arms. The wrapper exports a separate
compile copy and matches those arms by tokens, ignoring comments and whitespace.
Unknown or ambiguous structures fail before any source is written. A release that
needs a compatibility-rule change counts as needing an edit in #1072. Existing
supported arms need no overlay. These rules stay in the wrapper until upstream
ships equivalent support. The first contribution is tracked at
[openai/codex#55066](https://github.com/openai/codex/issues/55066).

The engine uses the upstream in-process app-server client on a current-thread
Tokio runtime. It excludes the Codex CLI and TUI from its dependency closure. Its
NDJSON bootstrap selects an isolated Codex home, working directory and ordinary
configuration overrides. `signalbox/ready` means initialization succeeded;
subsequent messages use app-server request, response and notification types.
Approvals remain server requests. The wrapper never auto-answers them.

## Build and proof

Run the commands below from `native/codex-wasm`. Python 3.11+, Node 24 and rustup are needed. The wrapper downloads pinned SDK and
Binaryen releases. Toolchain preparation puts patched Rust sources, libc, SDK and
dependency replacements in `.cache/`, leaving shared toolchains and Cargo sources
untouched. Use the machine's heavy-build slot for local installs, checks and builds.

```sh
heavy-slot python3.11 build.py --target wasm32-wasip1
heavy-slot python3.11 -m unittest discover -p 'test_*.py'
heavy-slot node --experimental-wasm-jspi --test loader.test.mjs
```

A successful build creates `engine.wasm`, `loader.mjs`, `manifest.json` and its
resolved `Cargo.lock` below `build/<version>-<commit>/<target>/artifact/`. The
manifest records source/module hashes, module bytes, imports, exports and proof
state. Building alone leaves it `built-unverified`. The target is below 60 million
module bytes; larger modules fail the build. The supported target is `wasm32-wasip1`.

`loader.mjs` accepts a statically imported `WebAssembly.Module` and the session
kernel's imports. It never compiles bytes at runtime. Async kernel imports are
explicitly declared for JSPI suspension. One command instance runs once.

`prepare_probe.py` produces a fixture for the shared #1057 local/deployed probe.
Run `python3.11 prepare_probe.py <artifact-directory> <fixture-directory>`, then
from the repository root run `node apps/cloud/infra/isolateProbe/measure.ts
--fixture <fixture-directory> --output <evidence-file>`. For a deployed probe, set
`PROBE_SECRET` and add `--url <probe-origin>`. The runner installs its fixture
internally and verifies module inventory and version responses. CI builds a fresh engine and runs the local proof.

The fixture's `/version` route instantiates the fully linked engine and executes `--version`.
That proves artifact loading and execution, not an agent turn. The fixture's WASI
host rejects every syscall outside that narrow proof. Full mock-model turns,
resume, tools, MCP and interruption belong to #1069 and the #1072 release replay.
