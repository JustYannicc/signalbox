# Synced browser tabs

A thread's browser tabs follow it to every device (#585). Signalbox syncs the
browsing, not the browser (#343): the thread keeps a record of its open tabs,
the active tab, where each tab was read to, and the pages it visited. Every
device loads that record into its own engine with its own session: the desktop
app's `<webview>`, the mobile app's WebView, and later an agent's Kernel
browser (#574). Cookies, tokens and form values never enter the record; each
engine signs itself in (#586).

The contract is [`signalboxBrowsing.ts`](../../packages/contracts/src/signalboxBrowsing.ts).
Its shape follows Chrome's shared tab groups: one shared list, fractional order
keys, last writer wins per field. A tab's position is a text directive, as
Chrome's Send Tab to Self carries it, with a scroll ratio as the fallback.

## Its own log, not the thread's

Tab changes are events, but in a browsing log beside the thread's
conversation log, inside the same Durable Object
([`thread/browsing/`](../../apps/cloud/src/thread/browsing/)). Scroll positions
land every few seconds while someone reads. In the conversation log they would
go to every thread subscriber, count against its replay window and reach the
owner's automations. The browsing log only reaches clients that subscribed to
the thread's tabs. A subscriber always starts from the record, so the log needs
no replay and keeps only recent events for tracing who changed what.

## The panel's own RPCs, served from the record

The desktop panel opens, reports, navigates and closes tabs through upstream's
`preview.*` RPCs from many entry points. Signalbox Cloud serves those from the
record ([`browsingRpc.ts`](../../apps/cloud/src/thread/browsing/browsingRpc.ts))
instead of hooking every caller. Viewport, zoom, colour scheme and reload stay
with the device that asked. The global `subscribePreviewEvents` stays empty in
the cloud; panels read each thread's browsing stream instead. A self-hosted
server keeps its in-memory panel and doesn't advertise `threadBrowsing`.

## One owner per tab

Every tab has one owner, a person or an agent, and only the owner navigates,
positions or closes it (#343). Anyone in the thread can switch to a tab or
reorder the list. A person's own tabs load in their devices' engines. An
agent's tabs live in its cloud browser (Kernel or the runner's Chromium) and
never load in a person's engine: agents always run in the cloud and never
drive a person's local tab. The cloud enforces this in
[`browsingDecider.ts`](../../apps/cloud/src/thread/browsing/browsingDecider.ts),
and each engine only loads what `isOwnedBy` says it drives. Following,
copying, sharing and lending a tab (#597) build on the owner.

## Who changed it

Every event names its member: one of a person's devices or an agent. The cloud
derives a device's id from a hash of its connection's session and sends each
subscriber its own identity in the snapshot. A device skips reapplying its own
changes, which is what keeps two engines from echoing a navigation back and
forth. Position restores only when someone else moved it.

## Signing in on each device

Each engine signs itself in from the person's 1Password (#586), through the
same grant check and folder-tree credentials as agents' sign-ins (#576), in
[`DeviceSignIn.ts`](../../apps/cloud/src/signIn/DeviceSignIn.ts). Three
constraints shape it:

- **Lazy.** An engine looks for a login form only while its tab is in front of
  the person. A tab arriving through sync must never sign in, since every
  sign-in on a new engine can mean a Google "is this you?" prompt.
- **One step at a time.** The device asks for exactly the kinds the form's
  current step shows, so a value never reaches a page that didn't ask for it.
  The same step reappearing right after a fill is the site refusing, and the
  tab goes quiet instead of retrying
  ([`deviceSignIn.ts`](../../packages/client-runtime/src/browsing/deviceSignIn.ts)).
- **Filled like an extension.** Values go in through the input's value setter
  and DOM events from a page script, the way password manager extensions fill.
  No debugger, synthetic input or user agent change, which is what sites'
  automation checks catch. The desktop keeps Electron's user agent because
  Turnstile breaks without it (see `BrowserSession.ts`).

Google refuses sign-in inside app web views, so the phone opens Google hosts in
the system browser view, where 1Password's AutoFill signs in. That view hides
its address, so those tabs sync one way.

## Position

[`pagePosition.ts`](../../packages/client-runtime/src/browsing/pagePosition.ts)
holds the in-page scripts every engine injects. Capture hit-tests the top of
the viewport instead of walking the document, so polling it stays cheap on long
pages. Restore retries for apps that render late and stops as soon as the
reader scrolls.
