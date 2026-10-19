# Host WebSocket ABI v1

Frozen with #1067. `signalbox_ws_v1` imports are synchronous, nonblocking wasm32 C functions. Every argument and return is `u32`; pointers address guest memory for that call only. No import retains a pointer, calls back into the guest, awaits a receive, or suspends the guest. JSPI suspension belongs to the existing Mio/Tokio reactor's WASI `poll_oneoff` park.

```
ws_open(request_ptr, request_len, out_fd_ptr) -> errno
ws_handshake(fd, out_ptr, capacity, out_required_ptr) -> errno
ws_recv(fd, out_opcode_ptr, out_ptr, capacity, out_required_ptr) -> errno
ws_ready(fd) -> errno
ws_send(fd, opcode, data_ptr, data_len) -> errno
ws_flush(fd) -> errno
ws_close(fd) -> errno
ws_drop(fd) -> errno
```

Returns are positive WASI errno values, including success `0`, `EAGAIN=6`, `EBADF=8`, `EINVAL=28`, `EIO=29`, `EMSGSIZE=35`, `ENOBUFS=42`, `ENOTSUP=58`, and `EPIPE=64`. The guest uses the WASI errno mapping rather than a native platform mapping.

All lengths and numeric fields below are little-endian `u32`, except a close code, which is network-order `u16`. A blob is `length` followed by that many bytes.

`ws_open` input contains version `1`, maximum frame bytes, maximum queue bytes, a UTF8 URL blob, header count, and that many ASCII-name/raw-value blob pairs. Header names may repeat. Limits are positive frame size at most 1 MiB, queue size at least the frame size and at most 4 MiB for each direction, URL at most 8 KiB, and encoded header count plus pairs at most 64 KiB. Guest and host enforce these bounds independently. The guest tightens Tungstenite's larger default frame/message/write-buffer limits to these host bounds; a caller's smaller message/frame limit still applies.

The first slice supports `ws://` on a validated loopback host after the connector resolves the route to `Direct`, including ordinary `connect` and explicit `connect_loopback_direct`. The host may dispatch a native workerd `WebSocketPair` endpoint without TCP. Proxy routes, non-loopback destinations, `wss`, custom CA environment settings, caller-supplied Rustls configurations, raw frames, and accepting unmasked frames fail explicitly. Default TLS construction and validation remain upstream; plain WS does not use TLS or TCP_NODELAY. This is no general transport or Codex parity claim.

A successful open immediately allocates one CONNECTING descriptor. An immediate error allocates nothing. The descriptor is in #1064's request-owned `KernelDescriptors` table, with the same `KernelWakeRegistry` used by the WASI host. Guest fd values must be at most `0x7fffffff` because installed WASI SDKs can expose signed `RawFd`. The guest closes an out-of-range allocation instead of truncating it.

`ws_handshake` returns `EAGAIN` while connecting. Once complete it copies HTTP status, header count, repeated name/value blob pairs, and an HTTP body blob. Statuses 100 through 599 are preserved; only 101 establishes a connection. Every other status becomes Tungstenite's `Error::Http` with duplicate headers and body intact. This preserves the outer connector's Set-Cookie handling for accepted and rejected upgrades. Header encoding is bounded by 64 KiB, HTTP body by 1 MiB, and total handshake encoding by 1 MiB + 64 KiB + 16 bytes. Transport failure returns an errno.

If capacity is insufficient, handshake and receive write the required length and return `ENOBUFS` without consuming anything. Receive also writes the pending opcode. A full successful handshake copy consumes its readiness once; later handshake calls return `EINVAL`. A full successful receive consumes exactly one message. A required length that fails to grow capacity or exceeds the negotiated bound is a host protocol error.

Receive/send opcodes are text `1`, binary `2`, close `8`, ping `9`, and pong `10`. Receive alone uses `0` with zero bytes for EOF. Text and close reasons are valid UTF8. Close is empty or contains an allowed network-order close code and UTF8 reason. Control messages are at most 125 bytes. Host adapters must declare their native automatic ping/pong behavior and return `ENOTSUP` for control writes they cannot represent.

`ws_ready` succeeds only when OPEN with one maximum-frame credit. Send is ordered and atomic. `EAGAIN` accepts no bytes and changes no frame queue; Rust retains at most one bounded pending message. Flush succeeds when accepted frames have been handed to native `WebSocket.send` in order. It does not promise network delivery. A deferred flush returns `EAGAIN`. Close is idempotent, starts graceful closure after queued writes, and returns `EAGAIN` until complete. After an operation blocks, write readiness must reflect its pending credit/drain/close requirement; spare queue credit alone must not keep a blocked flush or close ready.

Read readiness means an unconsumed handshake, complete frame, EOF, or error. Write readiness means open credit or progress of a pending write operation. HUP/error wakes both. `KernelDescriptors.resource(fd)` resolves the frame resource; ordinary byte reads on the framed resource are unsupported. Subscriptions use the shared kernel's subscribe-before-recheck logic.

The transport uses one default read/write `AsyncFd`. The WASIp1 selector delivers one-shot readiness for the exact fd/direction and disarms that subscription after delivery. Tokio defers rearm after a tick-aware readiness clear until the next poll, retaining the same `Registration`, `ScheduledIo`, token and task wakers. This bounds readiness for a canceled `next()` or `send()` even when the connection and other half stay live. There is no wrapper mutex, manual waker registry, self-wake, or second reactor. A full-mask rearm can produce one extra opposite-direction event; it must never produce a continuous level-triggered spin. Empty active subscriptions with no clock/external wake remain a reactor limitation; this slice's retained-half tests keep the other IO direction active.

`ws_drop` closes exactly the guest's descriptor reference. It must not directly close a resource still held by dup/fork aliases. The resource's final `close()` cleans its buffers, listeners and native transport exactly once. Rust unregisters its borrowed readiness handle before dropping its owned descriptor. Canceling a pending open/handshake or dropping a stream follows the same release path. The event loop owns resource state; there are no global guest callbacks or a second fd registry.
