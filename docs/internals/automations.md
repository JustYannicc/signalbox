# Automations

An automation is one TypeScript file an agent writes. The server compiles it into a diagram and a script, then runs the script durably. Source lives in [`apps/server/src/workflows`](../../apps/server/src/workflows); agents learn it from the built-in `signalbox-automations` skill in [`skill/`](../../apps/server/src/workflows/skill), which skills.sh installs into every harness and `automation_reference` also serves.

## The diagram comes from the code, strictly

[`compiler/`](../../apps/server/src/workflows/compiler) parses the file with oxc and walks only what shapes the run: step calls (`w.<verb>(label, …)`), `if`/`switch`/`?:`/`&&`, loops, `try`, `Promise.all`, and local helpers (inlined once per call site). Plain code between steps is invisible. Anything that would make the diagram lie is a compile error with a fix hint, never an "unknown" node: steps inside arbitrary callbacks, the receiver passed around, a computed label. The graph is a tree ([`workflow.ts`](../../packages/contracts/src/workflow.ts)), so clients lay it out top to bottom with a recursive box layout ([`layout.ts`](../../packages/client-runtime/src/automations/layout.ts)) instead of a general graph engine.

## Runs replay; steps are journaled

Each run re-executes the compiled script from the top in a fresh QuickJS sandbox ([`sandbox/`](../../apps/server/src/workflows/sandbox)) every time a step finishes. A step whose key is in the journal (`signalbox_automation_steps`) returns its stored result; a new one is recorded and started, and the run suspends until it settles. This is why:

- **Step keys must be stable across replays.** The compiler injects each call site's id (`s7`) as an extra first argument. The guest runtime adds `#n` for repeat calls in the same frame, `[i]` per `each`/`repeat` iteration, `.branch` for `parallel`, and the helper's call site. `workflowNodeIdForStepKey` strips the runtime parts to find the diagram node. Changing how keys are built breaks every run in flight.
- **Code between steps must be deterministic, even when branches run concurrently.** `Date`, `Math.random` and `crypto` are replaced in the sandbox. Journaled results don't resolve when a step is called: the host settles them one at a time in finish order, and each settlement sets the clock to that step's finish time and switches randomness to a stream seeded by the run id and that step's key (`parallel` branches, `each` items and `repeat` passes start on their own streams). So what a branch sees never depends on which other branches happened to be in the journal. A replay that reaches a recorded key with a different verb or label fails the run rather than continuing on wrong data.
- **Retries are journaled.** A step that fails transiently (network, timeout, 5xx/429, a model answer that can't be read) is parked as `waiting` with its attempt count bumped and `wake_at` set; the tick starts the next attempt. A restart neither loses nor repeats one. Replays that fail outside the code (storage, sandbox) are retried the same way, in memory, before the run fails.
- **A run replays one at a time; runs replay side by side.** [`replayQueue.ts`](../../apps/server/src/workflows/replayQueue.ts) queues a run once, and asking for a run that is replaying queues it once more for after, so one slow replay never stalls other runs.
- **Runs are pinned to the version that started them.** Saving makes a new version; running runs keep replaying their own script. A draft save stores a version without moving `version`, the live one triggers and runs use; publishing moves it.
- **A retry continues the run it retries.** It's a new run (`retry_of_run_id`) that replays with the original's seed and start time, and its first replay takes the original's succeeded steps in the order the code reaches them, while key, verb and label all match. The first step that doesn't match ends reuse for the whole run: keys are call-site ids, so on a newer version a step can land on another step's key, and anything after a fresh step may depend on its new result. See [`retry.ts`](../../apps/server/src/workflows/retry.ts).

## Steps run outside the sandbox

The sandbox has no network or filesystem. Step executors in [`WorkflowEngine.ts`](../../apps/server/src/workflows/WorkflowEngine.ts) do the real work:

- `agent`, `llm`, `judge`, `extract` launch ordinary threads (model steps in plan mode, settled after), so they use the user's providers and can be opened and steered. The thread id is stored on the step; terminal `run.updated` events settle it, off the event stream, and a once-a-minute sweep (also the first tick after a start) catches what a restart or a missed event left, so a restart can't lose a finished agent.
- `call` sends one generated call to Executor's execution API with the server's key. Automation code never sees credentials. Only full-access automations let Executor auto-approve; for others Executor's approvals stay in force.
- `run` executes a top-level function from the file in a Node subprocess with the file's imports installed per version under `<stateDir>/automations/` (install scripts off, a minimal environment without provider keys). It is gated on full-access automations because it runs arbitrary code on the server.

An automation acts with the runtime mode of the thread that saved it, so nothing may borrow more than it has: agents can't update or run an automation broader than their own thread, `w.start` can't start one broader than the caller, and `ask` steps are answered only by people through clients, never through MCP. Ending a run (cancel, failure, timeout, delete) interrupts its step fibers and agent threads with deterministic command ids and fails its open steps; cancel also cancels the runs it started.

## Event triggers ride the domain event stream

`{ on: … }` triggers react to orchestration-v2 domain events, which every provider adapter already produces, so one trigger works on every harness. [`automationEvents.ts`](../../packages/contracts/src/automationEvents.ts) is the one catalog: the normalizer in [`events/`](../../apps/server/src/workflows/events) has to build each name (a test holds it to that), the compiler checks `on` against it, and the skill and clients render from it. Every domain event also passes through raw as `orchestration.<type>`, so a new upstream event is usable before anyone names it.

- **Unwanted events cost a map lookup.** Subscriptions live in an in-memory index rebuilt only after a `definition` change (save, publish, toggle, delete); a cron firing or run activity never rebuilds it or lifts a rate pause. Thread reads happen only for events someone listens to, in a worker fiber off the stream, so slow reads never delay agent steps settling.
- **The stream is a live tail.** Nothing replays after a restart; events that happened while the server was down never trigger. The dedupe key (`event:<id>` in the webhook key table, pruned after a day) covers repeats of one fact, like several terminal `run.updated` for the same turn, so ids are semantic (`turn.finished:<runId>`), not domain event ids.
- **Loops are guarded three ways.** Threads and turns automations started don't trigger by default (their message ids start with `automation:`); an automation never sees its own runs' events, and runs started by automation events count toward the `w.start` depth; past `maxRunsPerMinute` an automation's event triggers pause until it's saved or switched. The pause is in memory, so a restart lifts it.

## Observability is one wide event per run

[`runLog.ts`](../../apps/server/src/workflows/runLog.ts) uses [evlog](https://www.evlog.dev) for automations only; the server's Effect logger is untouched and evlog has no global drain. Each run builds one event (automation, trigger, every step's latest state, the code's newest console lines) and writes it as NDJSON under `<stateDir>/logs/automations/` when the run ends, pretty in the terminal during dev. Open events live in memory, so a restart reopens a running run's event marked `resumed`. Failures the engine understands are evlog structured errors; their `why`/`fix` land on the step and run as `errorDetail`, which clients and `automation_run_read` show.

## Persistence stays out of upstream's migrations

Tables are `signalbox_automation*` and create themselves ([`storeSchema.ts`](../../apps/server/src/workflows/storeSchema.ts)): a new column goes in its CREATE statement and in `ADDED_COLUMNS`, which adds it to existing tables, while a constraint change needs a table rebuild; settings live in `<stateDir>/automations.json`, and the Executor API key in the server secret store so the file never holds a credential. See AGENTS.md for why fork code doesn't take migration numbers or settings.json keys.
