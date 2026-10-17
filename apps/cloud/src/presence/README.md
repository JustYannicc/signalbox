# Presence

`Presence.ts` exposes explicit, scoped location joins and live people views.
`PresenceAccess.ts` is the injected Catalog-owned authorization interface.
Opaque target keys identify canonical threads or levels; they never grant access.

Observing does not publish. Multiple connections collapse to one person; closing
a join removes only its contribution. A thread join never implies a folder join.
The module keeps transient state only. It queues invalidations rather than rosters
and checks publisher and observer fences when a view is pulled.

`Reset` and `Revoked` clear the previous view and end that subscription. After a
reset, subscribe again through current authorization. Dependency failures are
typed unavailable, never empty rosters. The transport must preserve the current
authorization fence at its own final enqueue; already-sent bytes cannot be recalled.

This first slice is an in-process foundation tested through its root interface.
Catalog's runtime guard and the socket/location adapters are not wired yet.
Keep platform implementation under private `adapters/` when integrating it;
reuse the session recorder's connection key and authenticated identity.
