# Thread search

`ThreadSearch` is the interface used by clients, API callers and agents. It resolves current access through `SearchAuthority` before querying and rechecks selected items in their owning thread before returning content. Search cursors are opaque, expire, and bind to the caller, query and permitted homes.

`SearchIndex` is the engine interface. `CloudflareSearchIndex` wires the first adapter, a SQLite FTS index per canonical home. Thread objects deliver completed items through a durable outbox. `SearchBackfill` walks the complete thread registry and asks each existing thread to start that same feed. The index is a recoverable replica; it never owns thread history or permissions.

`threadFind` keeps the existing literal Find behavior over thread items. It does not use the cross-thread index. Keyword search and literal search are separate query modes.
