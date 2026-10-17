# Models

`ModelAccess` coordinates current thread or local-key authority, secret scrubbing,
pool forwarding and request reporting. Callers use its `serve` and `report` operations;
the thread still owns its live turn and the pool still checks access on every request.

`ModelProtocol` holds the platform-free request and authorization types. Cloudflare
composition uses `cloudflare`; its adapter stays private under `adapters/`. Tests
exercise `ModelAccess` with the supplied authority from `testing`.

The gateway HTTP transport and pool administration are still separate modules during
the incremental move. CLIProxyAPI's release pin and patch paths remain in place.
