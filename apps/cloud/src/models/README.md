# Models

`ModelAccess` coordinates current thread or local-key authority, secret scrubbing,
pool forwarding and request reporting. Callers use its `serve` and `report` operations;
the thread still owns its live turn and the pool still checks access on every request.

`ModelCompletion` runs supplied-text requests without a thread on the owner's pool route
resolved by the caller. The pool checks access on every request; usage and timing stay on
completion spans. This path does not substitute secrets into the supplied text.

`ModelProtocol` holds the platform-free request and authorization types;
`ModelRecords` owns the request and usage schemas. `ModelGateway` serves provider
HTTP requests, with streaming, usage scanning and header handling kept private.
`ModelHttp` exposes the credential and header rules shared with pool links and local keys.

Cloudflare composition uses `cloudflare` and the `gatewayWorker` entry point; their
adapters stay private under `adapters/`. Tests use the public entry points and `testing`.
Pool administration is still separate during the incremental move. CLIProxyAPI's
release pin and patch paths remain in place.
