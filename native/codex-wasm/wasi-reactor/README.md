# WASI preview1 registration

`wasi_reactor.prepare_wasi_reactor(cache, source_boundaries, base_patches)` returns
a new, complete Cargo patch map. Only `tokio` and `mio` are replaced. Every other
base entry retains its original value. The caller integrates this map into the
wrapper build after review.

The helper copies the existing agentOS-patched Tokio 1.52.3 and extracts pristine
Mio 1.2.0 with checksum
`50b7e5b27aa02a74bac8c3f23f448f8d87ff11f92d3aac1a6ed369ee08cc56c1`.
Neither the base dependency cache nor source checkouts are modified. The entire
Tokio input and both patches identify the atomic output stage. Reuse checks its
package versions, identity, and complete crate file inventory. Symlinked crate
contents and output inside an input/source are rejected.

## Guest contract

- `mio::wasi::SourceFd(&raw_fd)` implements the existing `event::Source`
  registration methods on preview1 with `os-ext` and `os-poll`, including without
  Mio's `net` feature.
- `tokio::io::wasi::AsyncFd` and its existing readiness guards use Tokio's
  `Registration` and `ScheduledIo`. Enable Tokio `net` and `rt`, and use the
  existing WASI `tokio_unstable` build configuration.
- `std::os::wasi::io::{AsRawFd, RawFd}` is the fd interface. Rust's `RawFd` is
  signed; `SourceFd` checks its conversion into unsigned `wasi::Fd` and returns
  `InvalidInput` for a negative fd. This matches the kernel's allocated range
  `0..=0x7fffffff`.

Use a current-thread runtime and a nonblocking resource whose fd stays stable
until deregistration. `AsyncFd::new` can subscribe to both reads and writes.
The WASI selector disarms each delivered direction but retains its registration.
A canceled read or write future cannot leave an always-ready direction spinning.
Undelivered directions remain armed, and distinct fds can share a Mio token.

Tokio keeps readiness cached in the existing `ScheduledIo`. A readiness guard's
`clear_ready` first performs the usual tick-aware clear, then requests deferred
rearming. The next poll, readiness wait, or `try_io` rearms the original interest
mask through the same Mio registration and ScheduledIo token. Rearming failures
reach that fallible operation. Rearming both directions can produce one extra
opposite-direction event, which is disarmed on delivery. Direct Mio socket
`IoSourceState` rearms on `WouldBlock`; raw `SourceFd` callers explicitly
`reregister` after exhausting readiness.

Disarmed entries still support reregistration and deregistration. With no armed
fd and no clock, WASI cannot suspend for an arbitrary external task wake; polling
returns `Unsupported`. A timed poll still uses its real clock subscription.

The wrapper's receive call returns immediately, reporting `WouldBlock` when its
queue is empty. Its future uses `poll_read_ready` and `guard.try_io`, retries after
stale readiness, and returns `Pending` to Tokio. It never waits for a host reply
inside the future's poll method. `into_inner` deregisters without closing; drop
deregisters before dropping the resource.

Only the scheduler's existing Mio selector calls WASI `poll_oneoff`. The host
owns readiness subscription and JSPI suspension there. These patches introduce
no host import, second poller, global waker, self-wake loop, or timer. The existing
WASI selector still has no cross-thread waker. Native and Emscripten branches keep
their existing behavior.

The large upstream `async_fd.rs` remains one implementation shared by both
targets. Its WASI constructor attaches deferred-rearm metadata to the existing
registration. Keeping that module avoids copying guards, readiness clearing,
and cleanup into a second implementation. The registration's rearm state stays
beside its existing readiness and handle state so clearing and rearming cannot
silently use different tokens.

## Focused proof

Run from the repository root:

```sh
cd native/codex-wasm
~/.local/bin/heavy-slot python3.11 -B -m unittest test_wasi_reactor -v
```

The standalone runner uses the already-installed private Rust and WASI SDK. It
copies patched standard-library sources into its own sysroot, rebuilds only the
small probe and its dependencies with two jobs, and places panic runtime outputs
only in that copied sysroot. Its Cargo home and target directory are private to
the probe. It never builds Codex or changes the installed toolchain.

```sh
SIGNALBOX_KERNEL_WASI_MODULE=/path/to/kernel/KernelWasi.ts \
  ~/.local/bin/heavy-slot python3.11 -B native/codex-wasm/wasi-reactor/run.py \
  --output native/codex-wasm/wasi-reactor/out/proof \
  --host-adapter native/codex-wasm/wasi-reactor/host-adapter.mjs
```

The public kernel module must expose `createKernelAsyncWasi`, with sibling public
`KernelFileSystem.ts` and `KernelWakeRegistry.ts`. The default module path is this
checkout's `apps/cloud/src/kernel/KernelWasi.ts`; the environment override permits
the #1064 peer checkout or its immutable integration snapshot. Use `--runtime-only`
with an existing probe artifact and a fresh output directory to check a newer host
snapshot without compiling again. The fixture imports
no private WASI modules and copies no kernel. When a snapshot has `manifest.json`,
the runner verifies its file hashes before and after runtime execution.

`mio-only.rs` checks `os-ext` plus `os-poll` independently of `net`. The linked
Rust reactor then checks registration, reregistration, deregistration, rejected
negative fds, and Tokio ownership transfer. A receiver returns `Pending`, another
guest task sends an initialize JSON frame, the scheduler parks, and a host queue
reply wakes and resumes the receiver. The host also exercises readiness before
polling, readiness during subscription, and a stale event followed by `WouldBlock`.
Each run requires zero leaked wake tokens or fds and exactly one resource close.

`selector-cases.rs` also runs through actual Mio and the same public WASI host.
It covers shared tokens, simultaneous directions, disarmed registration lifetime,
clock-only polls, undelivered interests, HUP, and repeated direct
`TcpStream::try_io`/IoSourceState `WouldBlock` rearming. That test borrows custom
nonblocking fds without making socket network calls, then explicitly deregisters
and returns ownership. Both resources must close exactly once.

The fixture's only custom imports are synchronous
`signalbox_reactor_probe.{try_recv,try_send,close,record}`. They resolve the resource through
the public `KernelDescriptors.resource(fd)` attachment. Ordinary byte reads on
framed resources remain unsupported. The inherited agentOS `host_net.net_send`
import is reported and throws if exercised. These probe imports are not additions
to the registration adapter or a production WebSocket ABI.

This proves the compiled Tokio/Mio registration path against the public kernel
with a fixture queue. It does not prove the full engine, framed WebSocket
transport, browser hosting, or a production request. `report.json` and `build.log`
record each attempt; helper and patch identities remain separate from host proof.
