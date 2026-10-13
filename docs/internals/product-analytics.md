# Product analytics

The server owns PostHog delivery, opt-out, and identity for every connected client.
[Identity selection](../../apps/server/src/telemetry/Identify.ts) hashes an available
provider account ID, falling back to an installation-scoped ID. This identity can
span several clients; it does not identify a browser session. Clients do not load
the PostHog browser SDK. Client-use events require an authenticated connection, so
visiting the hosted app without connecting does not count as product use.

## Attribution boundaries

Client dimensions belong to the event's WebSocket connection. A server-global
"current client" would misattribute simultaneous web, desktop, and mobile use.
Provider execution has its own events because a turn can outlive the requesting
connection.

Keep client and server dimensions separate. A desktop host can serve a phone or a
remote browser, and a direct connection can cross a network. Older clients omit
metadata. Missing client values must stay unknown rather than being backfilled
from server properties. The legacy `clientType` property describes how the server
runs; use `surface` for the connected client.

## Interpreting events

Use `client.turn.requested` for active-use reports. `client.connected` counts
reconnects, so network behavior can inflate it. One identity can appear in several
client groups during a period; adding those groups double-counts users.

Provider send and completion counts need not match. Providers can emit synthetic
turns without a send request. Collection is best effort, with no scan or backfill
of provider history.

Token totals cover the main agent. Child agents and model rerouting prevent a turn
from representing one provider/model combination's full cost. For provider
comparisons, require complete usage, no observed subagents, and no mixed models;
compare matching model, effort, interaction mode, and terminal status. Aggregate
output/input ratios should divide the summed totals. Averaging per-turn ratios
lets small-input turns dominate.

Unknown counts stay absent. Partial usage contains valid observed counts but
cannot establish a whole-turn total. Keep these distinctions when changing token
normalization or building reports.

## Delivery

A send can fail after PostHog has stored the batch, so every retry is a copy.
[Delivery](../../apps/server/src/telemetry/AnalyticsService.ts) gives each event a
uuid when it is recorded, backs off after a failed send, and drops a batch after a
few tries. Without these limits, one stuck batch was sent every second for days.

Signalbox sends every event to the PostHog project of [T3 Code](https://github.com/pingdotgg/t3code) and to its own.
[Each destination](../../apps/server/src/signalbox/analytics/ProductAnalytics.ts) is a
separate instance of upstream's service, so buffers and backoff never couple: a down
destination must not delay or drop the other's events. Signalbox's key is injected at
build time so upstream's hardcoded default stays untouched across syncs.

The Settings opt-out is checked at record time and again at send time. Retries mean a
batch can sit for minutes; checking only at record time would send it after the user
opted out.

## Workload usage

`workload.*` events record the raw resource use that the cost replay
(`scripts/workload-cost-replay.ts`) prices against machine providers (#116). They go only to
Signalbox's project and follow the same opt-out.

[Process usage](../../apps/server/src/signalbox/analytics/workload/processAttribution.ts) is
charged by ownership, not by directory: threads without a worktree share the project root, and the
idle harnesses of other threads in that root would otherwise inflate every turn's memory. It is
sampled on demand while a run is in flight. Subscribing to the resource monitor's live stream would
count as a viewer and keep it at its 1 s rate for as long as the server runs.

Signalbox Cloud sends the `cloud.*` counterparts from each thread's Durable Object
([CloudAnalytics](../../apps/cloud/src/thread/diagnostics/CloudAnalytics.ts)). They go through an
outbox in the thread's own storage rather than the server's in-memory buffer, because an object can
be evicted between a turn ending and the send. A turn is reported a short grace after it ends. The
ModelGateway reports a request's tokens only once its stream closes, and that can land after the
harness has already ended the turn. Usage counters reset on every machine wake, so a turn's CPU is
summed per generation from the Runner's samples, never taken as a difference across a replaced
machine.

## Collection boundary

Keep analytics payloads to product metadata and normalized measurements. Do not
send prompts, authentication material, raw provider payloads, user-assigned device
names, or conversation identifiers. Client metadata is best effort; invalid values
must not reject a connection. PostHog person profiles remain disabled.
