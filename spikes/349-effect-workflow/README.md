# Spike #349: automations on `effect/workflow` on Cloudflare

Throwaway. This branch never merges; the verdict is on #349.

It runs real Signalbox automations (the built-ins "Watch pull request", "Wait for" and "Merge gate", plus a #294-shaped "Fix an alert") on Effect's `effect/workflow`, inside one Cloudflare Durable Object.

- `src/DurableObjectWorkflowEngine.ts`: an `effect/workflow` `WorkflowEngine` on Durable Object SQLite and the alarm. effect 4.0.4 ships none for Cloudflare.
- `src/automationWorkflow.ts`: one generic workflow; each `w.<verb>` becomes an `Activity`, `DurableDeferred` or `DurableClock` named by the step's call-site key.
- `src/guest.ts`: the engine's guest receiver, same keys. No sandbox and no deterministic time/random; see the comment.
- `src/world.ts`: a stand-in Signalbox (threads, PRs, asks, listeners, hooks). Models and agents are stubs.
- `scripts/compile-automations.ts`: compiles the automations with the server's own compiler. `generated/manifest.json` holds the source SHA-256s.
- `evidence/`: the live run on `signalbox-spike-349` (deleted afterwards), with two redeploys mid-wait.

## Run it

```sh
pnpm install                       # in this directory; it's its own workspace
node_modules/.bin/vitest run       # the #397 and #294 flows on a node:sqlite fake, incl. a redeploy
(cd ../.. && node spikes/349-effect-workflow/scripts/compile-automations.ts)   # needs the root install
CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… node_modules/.bin/alchemy deploy --stage spike --yes
node_modules/.bin/alchemy destroy --stage spike --yes
```
