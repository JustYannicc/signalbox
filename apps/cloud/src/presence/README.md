# Presence

`presence.ts` exposes explicit, scoped location joins and live people views.
`presence-access.ts` is the injected authorization interface owned by Catalog.
Opaque target keys identify canonical threads or levels; they never grant access.

Observing does not publish. Multiple connections collapse to one person; closing
a join removes only its contribution. A thread join never implies a folder join.
The module keeps transient state only.

`Reset` and `Revoked` clear the previous view and end that subscription. After a
reset, subscribe again through current authorization. Dependency failures are
typed unavailable, never empty rosters. The transport must preserve the current
authorization fence at its own final enqueue; already-sent bytes cannot be recalled.

Invalidation permanently closes a guard. A publisher adapter must close its old
join scope and rejoin through fresh authorization after reset. A failed publisher
keeps the target unavailable until its join scope closes, so losing authorization
infrastructure cannot silently report that nobody is there.

Platform adapters belong under private `adapters/`. Use the authenticated
connection's existing key and identity.
