# SQLx SQLite WASI worker

`worker_wasi.rs` adapts SQLx 0.9.0's SQLite connection worker for
`wasm32-wasip1` without atomics. See [NOTICE](NOTICE) for provenance and
license.

The `prepare_sqlite_dependencies(cache, source_boundaries, base_patches)`
helper returns the complete patch map, replacing only `sqlx-sqlite`. The upstream
crate archive is checksum-pinned. The native worker remains the upstream file.

The WASI worker uses a FIFO unbounded command queue so transaction rollback
from `Drop` can enqueue without blocking the current-thread executor. This
means SQLx's `command_buffer_size()` option does not bound commands on this
target. `row_buffer_size()` still bounds query rows; the worker awaits each
row send, preserving streaming backpressure.

Build the standalone SQLite command probe using the prepared private toolchain
and the pinned official release lockfile. Its output must be outside the wrapper
and all inputs:

```sh
~/.local/bin/heavy-slot python3.11 -B native/codex-wasm/sqlite/build_probe.py \
  --lockfile native/codex-wasm/.cache/sources/codex/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/Cargo.lock \
  --output /tmp/codex-sqlite-probe
```

The launcher only builds the WASI module and writes a report. The module uses
the bundled SQLite library and default SQLite VFS; run it in the parent-owned
isolate fixture to prove database persistence there. It creates a table, checks
automatic and committed writes, explicit rollback, rollback-on-drop, canceled
row streaming, close, and reopen.
