# Threads and turns

Callers use `Threads.ts` for launch, dispatch, snapshots, history and live events.
`ThreadAccess.ts` holds the actor and typed errors without importing runtime code.
Compose `ThreadsLive.layer` with the transport, home/turn context, attachment and
crypto layers. Tests use that same interface with the in-memory cloud transport.

`core/` owns turn preparation, attachment claims and reconnect recovery. A stream
resumes after its last delivered event sequence; its batches keep T3 Code's
snapshot, event and synchronization-marker contract. Command receipts and events
still commit together before publication.

`CloudThreadService.ts` keeps the existing core method names for compatibility
and owns the browser/preview entry points. `ThreadDirectory.ts` bridges the
thread transport. The engine, store, runner and Durable Object implement the
canonical thread model behind these entry points.

Catalog owns discovery, current access and destination shell/status projections.
Threads owns canonical history and the source outbox. Each projection consumer
acknowledges its own durable receipt; search delivery has an independent cursor.
