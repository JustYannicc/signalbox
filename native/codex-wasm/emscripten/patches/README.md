# Emscripten dependency adapter

This is a compile-boundary adapter, not a working Codex runtime. Use only for
`wasm32-unknown-emscripten`, with `--cfg tokio_unstable` and the wrapper's JSPI
link settings. `prepare_emscripten_dependencies(cache, sources)` returns absolute
paths to checksum-pinned dependency copies. Cargo version aliases keep
the original package names, so older and newer dependencies can coexist.
Codex, reference checkouts and completed cache stages are not changed. Native
and WASI branches stay intact. Unsupported Emscripten operations return errors;
a compile pass does not establish their availability at runtime.

The Mio adapter reuses its existing Unix `poll` selector, registration, event
translation, and socket implementations. Its Emscripten waker and wait call go
through an explicit host reactor. It never substitutes Emscripten's nonblocking
`poll` stub for a suspending reactor, and it does not pretend the target is WASI.
Tokio's standalone parker uses the same host reactor. Socket creation, accept,
pipes and socketpairs explicitly set nonblocking flags through the Unix fd API.

## Required adapter imports

`emscripten/host.mjs` implements these adapter imports using injected shared
kernel readiness functions. There is no fd bridge yet. Its default local mask is
1, so the full Codex feature mask 31 is rejected. Missing imports fail
instantiation. A host without the required operations must reject them rather
than return success. Do not add no-op fallbacks to get a runtime smoke to pass.

These are module-local adapter imports, not a second Signalbox kernel ABI.
The shared kernel contract is ABI version 1 in `KernelAbi.ts` and
`KernelWakeRegistry.ts`, owned by #1061. Its results are `ok`, `error`, or
`would_block` with an opaque string `WakeToken.id`. The JSPI owner must negotiate
that ABI, use `attemptKernelOperation` to subscribe **before** trying I/O, wait on
the wake registry outside the ABI, and retry after one-shot readiness. It must
release all registrations on cancellation, reactor drop and guest exit. Numeric
reactor handles and the required-feature mask below stay inside this module's
adapter; they do not extend `KernelCapability` or replace opaque kernel handles.

Imports are in `signalbox_emscripten`. Pointers and lengths are wasm32 integers.
Every function returns zero or a **positive Emscripten libc errno**, not WASI,
Linux, a negative errno, or a JavaScript Promise object passed through as an int.
Negative errnos are rejected as invalid host data.

```c
int32_t runtime_require(uint32_t required_capabilities);
int32_t reactor_new(uint32_t *handle_out);
int32_t reactor_drop(uint32_t handle);
int32_t reactor_wake(uint32_t handle);
int32_t reactor_poll(uint32_t handle, struct pollfd *fds, uint32_t count,
                     int32_t timeout_ms, uint32_t *ready_out);
```

`runtime_require(mask)` runs before Tokio builds either a `Runtime` or a
`LocalRuntime`. It requests the capabilities of the **activated Cargo features**.
The host must return `ENOTSUP` or `ENOSYS` for a missing bridge. It must not
advertise process or signal support just because Emscripten exports stub symbols.

| Bit | Required behavior                                                              |
| --- | ------------------------------------------------------------------------------ |
| 1   | Single-threaded JSPI parking, wake latches, and a progressing monotonic clock. |
| 2   | Filesystem/stdio fd operations for `fs` or `io-std`.                           |
| 4   | Emscripten-compatible TCP/UDP/Unix socket and DNS operations for `net`.        |
| 8   | Process spawn, wait, kill, exit status and child pipes for `process`.          |
| 16  | Signal registration, delivery, masking and SIGCHLD for `signal`.               |

The full Codex graph requests mask **31**. This handshake checks a host's declared
contract; it is not evidence that the implementation fulfills it. Unsupported
individual operations must also return an error.

A reactor handle owns a sticky, coalescing wake latch. `reactor_wake` records a
wake even before a poll begins, and resolves an outstanding poll. `reactor_poll`
consumes that latch, observes requested fd readiness and writes `revents` plus
the number of nonzero `revents` entries to `ready_out`. It clears old `revents` on
every call. A wake without fd readiness returns count zero, not a synthetic fd.
Timeout `-1` means indefinite, `0` means a synchronous check, and a positive value
means a deadline in milliseconds. Empty fd sets are valid for timer/park waits.
Errors and unknown handles must be reported. Dropping releases all host state.

`pollfd` has the Emscripten layout, `int32 fd; int16 events; int16 revents`, eight
bytes per entry. Use Emscripten poll flags, including error/hangup/invalid-fd
reporting. Fds must share the exact namespace used by Emscripten libc, Rust std,
child pipes and the host, with correct close/dup and nonblocking semantics.
An AgentOS fd or WASI errno cannot be passed through without translation.

`imports.js` declares exactly these five functions for Emscripten's JavaScript
linker. Its bodies throw if called; the loader supplies the real imports from
the request host. The SDK helper adds this library through encoded Rust link
flags. Undefined-symbol errors remain enabled, and the resulting WASM retains
the `signalbox_emscripten` namespace.

Only `signalbox_emscripten.reactor_poll` may suspend. Supply it through the
loader's `host.suspendingImports`. Enter the guest through JSPI. The host must
copy request data before suspending and refresh memory views before writing the
reply, since memory may grow. Do not reenter the guest scheduler or mutate Mio
registrations while its select call is suspended; the existing selector holds
its fd mutex. The wake path is separate and may interrupt a pending poll. There
must be no pthreads, shared memory, or host worker threads behind this adapter.

## Host wiring

Pass the request-owned `wakes` and `attemptKernelOperation` from the shared
kernel, plus `subscribeFd({fd, events}, notify)` and synchronous `tryPoll(requests)`
callbacks. `subscribeFd` returns an unsubscribe function for **each** registered
fd in the poll snapshot. `tryPoll` returns a shared `KernelResult` whose `ok` value
is an array of Emscripten `revents`, one entry per request, or `would_block`
without a token. It must not return a Promise. The host bridge installs all fd,
wake and deadline subscriptions before attempting readiness. It waits on the
shared wake token, retries, and releases all registrations on every path. A
notification without readiness causes a new subscription/attempt, not a sleep
loop. Deadline timers only notify at the requested deadline.

The #1064 pipe shape fits these callbacks: map the local fd to the endpoint and
call `pipe.subscribe('read' | 'write')(notify)` before `pipe.ready(direction)`.
Closed endpoints count as ready; the next `tryReadInto` returns EOF or `tryWrite`
reports `EPIPE`. Preserve any `POLLHUP`, `POLLERR` and `POLLNVAL` supplied by the fd
adapter. Polling must not drain the pipe or turn EOF into an endless wait.
Reacquire guest memory for the subsequent I/O and after every suspension.

`reactor_drop` and `host.dispose()` release **their own** wake registrations and
reactor state. They do not close a shared pipe endpoint. The fd open-description
owner invokes `onLastClose` exactly once; closing one reactor must not close
another reactor's pipe. The request owner also disposes the shared registry on
exit. Registry expiry is reported as Emscripten `ETIMEDOUT`; configure its lifetime
for the request rather than silently extending expired/cancelled operations.

The returned `imports`, `suspendingImports` and `attach` fit the existing loader.
Always call `host.dispose()` in the caller's `finally` after `loaded.run()`. The
module-local capability mask is a check on supplied implementations, never a
substitute for the kernel's negotiated ABI or registered program authority.

## Process and signal boundary still missing

Emscripten Rust std uses its Unix process implementation. AgentOS's Tokio process
adapter calls a separately patched **WASI std::process**, `host_process` imports,
and WASI fd flag calls. Copying that file or changing `target_os` cannot connect
Emscripten's std process objects or descriptor namespace to the AgentOS host.
This adapter leaves those APIs enabled and requires the host capability before
runtime construction. It does not turn unsupported processes into fake children
or unavailable signals into futures that wait forever. Unix peer-credential
queries return `ErrorKind::Unsupported`, never fabricated uid/gid zero.

The current shared kernel exposes `process.spawn`, `process.wait`,
`process.signal` and `escalate`; filesystem operations are separate. Its spawn
requires a registry-resolved program, args and env. A caller-selected executable
path is not a resolved program. It has no cwd, stdio file actions or process
groups yet. Wait currently returns only `exitCode`. Sending `terminate`/`kill`
through `process.signal` is not Unix signal subscription/delivery or signal masks.
Those gaps require agreement with that owner, not a second process ABI here.
The adapter must map kernel errors to Emscripten errno and keep string kernel
handles/wake tokens in an instance-owned numeric lookup table. It must reject
operations that the shared contract cannot represent.

The next implementation needs an Emscripten std/libc bridge or a dedicated
Tokio process implementation. The existing AgentOS reference to adapt is
`host_process.proc_spawn_v3`, `proc_waitpid_v2`, `proc_kill`, `fd_pipe` and
`fd_setfd`. Spawn must carry executable, argv, env, cwd, stdio fd actions,
process-group settings and signal mask/defaults. Wait must preserve running,
normal exit, signal termination and core-dump states. Pipes must be nonblocking
and appear in the reactor's fd namespace. Child exit and subscribed signals
must wake waiting tasks. Those functions use WASI errno/flag conventions today;
a real Emscripten adapter must translate them. Unix signal registration also
needs actual delivery and its self-pipe/socketpair or a replacement signal
implementation; the SDK's stubs do not provide it.

## Inline blocking limitation

Like the AgentOS single-thread port, this adapter runs blocking work **inline**.
It reuses Tokio's existing task harness so completion, shutdown cancellation and
hooks still use Tokio's normal join machinery. Both `tokio::task::spawn_blocking`
and `Handle::spawn_blocking`, including mandatory filesystem jobs, reach this
same path. It creates no worker threads. Requesting a multithread runtime returns
`ErrorKind::Unsupported`; it does not silently select a different runtime.

Inline execution does **not** preserve blocking-pool concurrency. A closure runs
before `spawn_blocking` returns, so a long-lived PTY reader or child-wait loop can
pin the only executor thread. Another Tokio task cannot run to interrupt it.
JSPI parking for sockets/timers does not fix that scheduling dependency.
`block_in_place` on a current-thread runtime retains Tokio's rejection. Operations
that synchronously wait for another guest task need a different cooperative
implementation. Do not claim interrupt, PTY or full-turn parity from successful
compilation, a timer/socket smoke, or a host capability response. Parent-owned
full-engine checks and full-turn tests are still required.

## Prior work

- [Mio poll backend](https://github.com/tokio-rs/mio/blob/v1.2.0/src/sys/unix/selector/poll.rs)
  and its single-threaded WASI waker provide the registration/readiness model.
- [AgentOS Tokio port](https://github.com/rivet-dev/codex/tree/8f4655a9dbfc7db91768c78ccaea7357ba47127e/codex-rs/vendor/tokio-wasi)
  demonstrates inline blocking on a single-thread runtime. Its process adapter
  requires AgentOS's patched WASI stdlib.
- [Tokio Emscripten discussion](https://github.com/tokio-rs/tokio/issues/8194)
  and [JSPI implementation](https://github.com/guybedford/tokio/pull/1) explain the
  host parking problem. That work's net support depends on newer Emscripten/Mio
  changes and does not provide the wrapper's required process/signal bridge.

## Focused verification

Tokio-util's UDP module is enabled for Emscripten because this copied Tokio
provides the socket API that the module wraps. Rama otherwise fails at its
`UdpFramed` re-export. This preserves that API in the compile carrier; it does
not implement UDP in the host. The runtime still requires the host's networking
capability, and the default host rejects it.

Run the preparation tests with Python 3.11. The JS host tests import the actual
shared `KernelAbi.ts`, `KernelWakeRegistry.ts` and `KernelPipe.ts`. Before that
dependency lands here, set `SIGNALBOX_KERNEL_ABI_MODULE` to the other checkout's
absolute `KernelAbi.ts` path. Production `host.mjs` receives those functions by
injection and has no import of their TypeScript implementation.

Run `emscripten/patches/probes/run.py --output <fresh-temporary-directory>
--graph <full-engine-cargo-graph.json>` under heavy-slot. It reuses the installed
private Rust and pinned SDK helper, checks the actual Tokio/Mio/socket2/libc
versions and features against that graph, runs Cargo check, produces a real
Emscripten link, and uses the existing loader/generated factory for a JSPI
runtime proof. It never starts a WASI or Codex engine build. It needs a Node host
with modern `WebAssembly.Suspending`/`promising`; the SDK's bundled Node 22 does
not expose that API, while Node 24 with `--experimental-wasm-jspi` does.

The runtime probe uses the real shared wake registry and the injectable host
bridge, with a deliberately synthetic capability response. It proves only the
executed timer/park/waker paths, inline blocking order and shutdown cancellation.
It also checks missing imports, unsupported capabilities, invalid host responses
and interruption errors. It does not advertise filesystem, fd readiness,
network, process, signal or PTY implementation in that synthetic host. Shared
pipe readiness, EOF/EPIPE, memory growth and registration cleanup are tested
separately in `emscripten/host.test.mjs` against the real pipe implementation.
