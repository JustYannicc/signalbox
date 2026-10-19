# Model gateway Responses WebSocket contract

This contract describes the Cloud model gateway's WebSocket path for Codex's
OpenAI Responses API. It does not claim the current `ModelGateway` HTTP handler
implements that path. Model access and composition remain in the
[models module](../../apps/cloud/src/models/README.md); the injected
[Kernel WebSocket host ABI](../../native/codex-wasm/websocket/CONTRACT.md)
defines the native transport boundary.

The source anchor is OpenAI Codex `0.162.1`, upstream revision
`092d3acd6bec3e3a14bdc7e7a2810ab628ab759d` (`codex-rs/core/src/client.rs` and
`codex-rs/codex-api/src/common.rs`). This is Codex-specific. The inspected
Claude Code `2.1.302` and `2.1.303` clients use the Messages HTTP SSE path; this
contract does not grant them WebSocket support.

## Authority and routing

The client opens the provider's Responses endpoint, routed through Signalbox
as `/openai/v1/responses`, with the normal HTTP WebSocket upgrade and model
authorization headers. The gateway authorizes the opening request through the
existing model-access boundary and pins its granted run, provider, and pool for
the socket lifetime. Caller input cannot choose another pool or upstream
destination, and the Signalbox model token must not reach the upstream model
service. Close the channel when its grant ends or execution is cancelled.

The model gateway owns provider authorization, pool selection, and the meaning
of the request. An injected `KernelWebSocketRoute` owns only the authorized
network dial, TLS handshake, and socket returned to the WASI client. It does
not add model authority or choose an account.

## Wire behavior

Codex's built-in OpenAI provider enables Responses WebSockets by default. A
custom provider defaults to HTTP unless its configuration explicitly declares
WebSocket support. Codex sends JSON messages with a top-level `type`; requests
are flat `response.create` objects, for example:

```json
{"type":"response.create","model":"...","stream":true,"input":[...]}
```

One socket can carry multiple `response.create` requests. A best-effort
prewarm may use `generate:false`; later requests may carry
`previous_response_id` and only incremental input. Responses are also flat JSON
events, such as `response.created`, `response.output_text.delta`, and
`response.completed`. The gateway forwards complete messages in order without
wrapping, translating, coalescing, or dropping unknown event types.

Codex reuses a healthy connection. If it detects a closed connection or changed
provider/auth headers, it opens another and resets its continuation state; the
next request includes full input and omits `previous_response_id`. An HTTP 426
upgrade response, or exhaustion of Codex's WebSocket retry policy, switches the
Codex session to HTTP. The gateway preserves the handshake result and does not
invent its own retry, replay, or HTTP fallback. Codex may retry through its own
policy; the gateway treats each submitted `response.create` as a new request and
does not claim idempotence or replay a request whose outcome is unknown.

## Handshake, bounds, and lifecycle

Preserve the handshake status, raw header pairs, and rejection body for the
native client. Statuses from 100 through 599 remain observable; only 101
establishes a socket. Repeated headers, including separate `Set-Cookie`
values, remain available to the connector. In particular, preserve 426 so the
client can apply its fallback policy. After 101, preserve complete text and
binary messages and their order. Workerd owns TLS and native WebSocket control
frames; adapters that cannot represent a control operation return an explicit
unsupported error.

The native contract bounds the URL at 8 KiB, encoded request headers at 64 KiB,
each frame at 1 MiB, and each directional queue at 4 MiB. A rejected handshake
body is bounded at 1 MiB. Enforce bounds on both sides of the WASI boundary.
Cancellation aborts an in-flight open and releases its descriptor and socket.
Close drains accepted queued writes before graceful shutdown; an incomplete
close stays pending until completion or failure. A successful `flush` means
only that frames were handed to the native WebSocket send queue, not that the
peer received or applied them.

Keep three observations distinct:

- If the gateway exposes a durable ACK, it means a frame and sequence were
  committed to gateway storage. It proves neither socket delivery nor model
  processing.
- Transport delivery requires evidence at the peer-side socket boundary; a
  local `send` or `flush` proves only local acceptance.
- Native application receipt occurs when the guest's `ws_recv` returns a
  complete message to Codex. The gateway cannot infer this from its ACK.

If the model responds with `response.created`, that is upstream application
evidence that it accepted the request; it still does not prove Codex received
the event. Do not label any earlier acknowledgement as delivered or completed.

## Open operating conditions

Transparent recovery after native engine eviction remains unqualified. The
current WASI facet has no proven way to rebind the same guest stack, parser,
and file descriptor after eviction. Starting a replacement turn or regenerating
the request is new model work, not transparent continuation. Until #1070
qualifies same-invocation recovery, an uncertain in-flight request stays
uncertain; this contract does not promise eviction recovery or safe replay.

The inspected workerd build `fa8b9d343f00c200b8e8d314c541c33be9e1ee70`
captures the socket read loop's `IoContext` and calls that context's
`topUpActor` hook. The source does not expose the deployed allowance calculation. Propagation
to the session Durable Object/facet and continuation of its live JSPI call have
not been proven in deployment; a working socket alone is not evidence of that
operating condition.

The generic WASI connector accepts only routes resolved to `Direct`; proxy
routes and unresolved transport policy are unsupported. Workerd supplies
default TLS and owns control frames. Custom-CA environment settings and
caller-provided Rustls configuration are unsupported, and TCP_NODELAY has no
host equivalent. Explicit loopback-direct connections remain loopback-only;
ordinary connections may reach a remote destination only through an
authorized injected route.
