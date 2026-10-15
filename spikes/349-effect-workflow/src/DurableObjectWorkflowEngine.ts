/**
 * An `effect/workflow` engine that lives inside one Cloudflare Durable Object.
 *
 * effect 4.0.4 ships only `layerMemory` and the Cluster engine. Cluster keeps
 * poll loops and shard locks running, so a Durable Object hosting it never
 * hibernates. This engine is the missing piece: executions, activity results,
 * deferred results and clocks live in the object's SQLite, clocks become the
 * object's alarm, and nothing is held in memory between wakes. A redeploy or
 * an eviction loses nothing: the next wake replays from SQLite.
 *
 * Usage: `make(state)` inside the object, provide the returned engine to the
 * workflow layers, call `alarm` from the object's `alarm()` and `recover` once
 * per object start. `idle` resolves when no execution is running, so a request
 * can keep the object alive until its runs have suspended or finished.
 */
import { Cause, Deferred, Duration, Effect, Exit, Fiber, Option, Schema, Scope } from "effect";
import { Workflow, WorkflowEngine } from "effect/workflow";

type Execute = (
  payload: object,
  executionId: string,
) => Effect.Effect<
  unknown,
  unknown,
  WorkflowEngine.WorkflowInstance | WorkflowEngine.WorkflowEngine
>;

interface Registered {
  readonly workflow: Workflow.Any;
  readonly execute: Execute;
  readonly scope: Scope.Scope;
}

interface Live {
  /** Completes when this attempt has suspended or finished. */
  readonly settled: Deferred.Deferred<void>;
  fiber: Fiber.Fiber<unknown, unknown> | undefined;
  rerun: boolean;
}

/** Stored exits hold already-encoded success and error values; only defects need a codec. */
const StoredExit = Schema.toCodecJson(Schema.Exit(Schema.Any, Schema.Any, Schema.Defect()));
const encodeExit = (exit: Exit.Exit<unknown, unknown>) =>
  JSON.stringify(Schema.encodeSync(StoredExit)(Exit.map(exit, (value) => value ?? null)));
const decodeExit = (json: string) =>
  Schema.decodeSync(StoredExit)(JSON.parse(json)) as Exit.Exit<unknown, unknown>;

// Spike payloads need no schema services.
const schemaFor = (workflow: Workflow.Any) =>
  Schema.toCodecJson(workflow.payloadSchema) as unknown as Schema.Codec<object, unknown>;

export interface Control {
  readonly engine: WorkflowEngine.WorkflowEngine["Service"];
  /** Fires due clocks and re-arms the alarm for the next one. */
  readonly alarm: Effect.Effect<void>;
  /** Restarts executions that were mid-run when the object went away. */
  readonly recover: Effect.Effect<void>;
  /** Waits until no execution is running in this object. */
  readonly idle: Effect.Effect<void>;
  /** Read model for the spike's status page. */
  readonly executions: Effect.Effect<ReadonlyArray<Record<string, unknown>>>;
}

export const make = (state: DurableObjectState): Effect.Effect<Control, never, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const sql = state.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS wf_executions (
      execution_id TEXT PRIMARY KEY,
      workflow TEXT NOT NULL,
      payload TEXT NOT NULL,
      parent TEXT,
      status TEXT NOT NULL,
      interrupted INTEGER NOT NULL DEFAULT 0,
      result TEXT,
      runs INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS wf_activities (
      execution_id TEXT NOT NULL,
      name TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      exit TEXT NOT NULL,
      PRIMARY KEY (execution_id, name, attempt)
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS wf_deferreds (
      execution_id TEXT NOT NULL,
      name TEXT NOT NULL,
      exit TEXT NOT NULL,
      PRIMARY KEY (execution_id, name)
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS wf_clocks (
      execution_id TEXT NOT NULL,
      workflow TEXT NOT NULL,
      deferred TEXT NOT NULL,
      wake_at INTEGER NOT NULL,
      PRIMARY KEY (execution_id, deferred)
    )`);

    const workflows = new Map<string, Registered>();
    const running = new Map<string, Live>();
    const deferredState = WorkflowEngine.makeDeferredState();

    const armAlarm = Effect.promise(async () => {
      const next = sql
        .exec<{ wake_at: number | null }>("SELECT MIN(wake_at) AS wake_at FROM wf_clocks")
        .one().wake_at;
      if (next === null) return;
      const current = await state.storage.getAlarm();
      if (current === null || current > next) await state.storage.setAlarm(next);
    });

    const persistResult = (executionId: string, result: Workflow.Result<unknown, unknown>) =>
      Effect.sync(() => {
        const now = Date.now();
        if (result._tag === "Complete") {
          sql.exec(
            "UPDATE wf_executions SET status = 'complete', result = ?, updated_at = ? WHERE execution_id = ?",
            encodeExit(result.exit),
            now,
            executionId,
          );
          sql.exec("DELETE FROM wf_clocks WHERE execution_id = ?", executionId);
        } else {
          sql.exec(
            "UPDATE wf_executions SET status = 'suspended', updated_at = ? WHERE execution_id = ?",
            now,
            executionId,
          );
        }
      });

    const resume = (executionId: string): Effect.Effect<void> =>
      Effect.suspend(() => {
        const row = sql
          .exec<{ workflow: string; payload: string; status: string; interrupted: number }>(
            "SELECT workflow, payload, status, interrupted FROM wf_executions WHERE execution_id = ?",
            executionId,
          )
          .toArray()[0];
        if (!row || row.status === "complete") return Effect.void;
        const inFlight = running.get(executionId);
        if (inFlight) {
          // A wake while a run is in flight replays once that run settles.
          inFlight.rerun = true;
          return Effect.void;
        }
        const entry = workflows.get(row.workflow);
        if (!entry) {
          // A deploy dropped this workflow. The run stays parked until a deploy registers it again.
          return Effect.logWarning(
            `workflow ${row.workflow} is not registered; ${executionId} stays parked`,
          );
        }
        const payload = Schema.decodeUnknownSync(schemaFor(entry.workflow))(
          JSON.parse(row.payload),
        ) as object;
        const instance = WorkflowEngine.WorkflowInstance.initial(entry.workflow, executionId);
        sql.exec(
          "UPDATE wf_executions SET status = 'running', runs = runs + 1, updated_at = ? WHERE execution_id = ?",
          Date.now(),
          executionId,
        );
        // Registered before the fork, so a run that settles synchronously still finds its entry.
        const live: Live = { settled: Deferred.makeUnsafe<void>(), fiber: undefined, rerun: false };
        running.set(executionId, live);
        const run = entry.execute(payload, executionId).pipe(
          Effect.onExit(() => {
            if (row.interrupted === 0) return Effect.void;
            instance.interrupted = true;
            instance.suspended = false;
            return Effect.withFiber((fiber) => Effect.interruptible(Fiber.interrupt(fiber)));
          }),
          Workflow.intoResult,
          Effect.provideService(WorkflowEngine.WorkflowEngine, engine),
          (effect) => deferredState.trackRun(instance, effect),
          Effect.tap((result) => persistResult(executionId, result)),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logError(`execution ${executionId} failed outside the workflow`, cause),
          ),
          Effect.ensuring(
            Effect.suspend(() => {
              if (running.get(executionId) === live) running.delete(executionId);
              return Deferred.done(live.settled, Exit.void).pipe(
                Effect.andThen(live.rerun ? resume(executionId) : Effect.void),
              );
            }),
          ),
        );
        return Effect.forkIn(run, entry.scope).pipe(
          Effect.tap((fiber) => Effect.sync(() => (live.fiber = fiber))),
          Effect.asVoid,
        );
      });

    const encoded: WorkflowEngine.Encoded = {
      register: Effect.fnUntraced(function* (workflow, execute) {
        workflows.set(workflow._tag, { workflow, execute, scope: yield* Effect.scope });
      }),
      execute: Effect.fnUntraced(function* (workflow, options) {
        const entry = workflows.get(workflow._tag);
        if (!entry) return yield* Effect.die(`workflow ${workflow._tag} is not registered`);
        const payload = JSON.stringify(Schema.encodeSync(schemaFor(workflow))(options.payload));
        const now = Date.now();
        const inserted = sql.exec(
          `INSERT OR IGNORE INTO wf_executions (execution_id, workflow, payload, parent, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'running', ?, ?)`,
          options.executionId,
          workflow._tag,
          payload,
          options.parent?.executionId ?? null,
          now,
          now,
        ).rowsWritten;
        if (inserted > 0) yield* resume(options.executionId);
        if (options.discard) return undefined as never;
        const live = running.get(options.executionId);
        if (live) yield* Deferred.await(live.settled);
        const done = yield* encoded.poll(workflow, options.executionId);
        return Option.getOrElse(done, () => new Workflow.Suspended({})) as never;
      }),
      poll: (_workflow, executionId) =>
        Effect.sync(() => {
          const row = sql
            .exec<{ status: string; result: string | null }>(
              "SELECT status, result FROM wf_executions WHERE execution_id = ?",
              executionId,
            )
            .toArray()[0];
          if (!row) return Option.none();
          if (row.status === "complete" && row.result !== null) {
            return Option.some(new Workflow.Complete({ exit: decodeExit(row.result) }));
          }
          return Option.some(new Workflow.Suspended({}));
        }),
      interrupt: (_workflow, executionId) =>
        Effect.suspend(() => {
          sql.exec("UPDATE wf_executions SET interrupted = 1 WHERE execution_id = ?", executionId);
          return resume(executionId);
        }),
      interruptUnsafe: (_workflow, executionId) =>
        Effect.suspend(() => {
          sql.exec("UPDATE wf_executions SET interrupted = 1 WHERE execution_id = ?", executionId);
          const fiber = running.get(executionId)?.fiber;
          return fiber ? Fiber.interrupt(fiber) : Effect.void;
        }),
      resume: (_workflow, executionId) => resume(executionId),
      activityExecute: Effect.fnUntraced(function* (activity, attempt) {
        const instance = yield* WorkflowEngine.WorkflowInstance;
        const stored = sql
          .exec<{ exit: string }>(
            "SELECT exit FROM wf_activities WHERE execution_id = ? AND name = ? AND attempt = ?",
            instance.executionId,
            activity.name,
            attempt,
          )
          .toArray()[0];
        if (stored) return new Workflow.Complete({ exit: decodeExit(stored.exit) });
        const activityInstance = WorkflowEngine.WorkflowInstance.initial(
          instance.workflow,
          instance.executionId,
        );
        activityInstance.interrupted = instance.interrupted;
        const result = yield* activity.executeEncoded.pipe(
          Workflow.intoResult,
          Effect.provideService(WorkflowEngine.WorkflowInstance, activityInstance),
        );
        if (result._tag === "Complete") {
          sql.exec(
            "INSERT OR REPLACE INTO wf_activities (execution_id, name, attempt, exit) VALUES (?, ?, ?, ?)",
            instance.executionId,
            activity.name,
            attempt,
            encodeExit(result.exit),
          );
        }
        return result;
      }),
      deferredResult: Effect.fnUntraced(function* (deferred) {
        const instance = yield* WorkflowEngine.WorkflowInstance;
        const stored = sql
          .exec<{ exit: string }>(
            "SELECT exit FROM wf_deferreds WHERE execution_id = ? AND name = ?",
            instance.executionId,
            deferred.name,
          )
          .toArray()[0];
        return stored ? Option.some(decodeExit(stored.exit)) : Option.none();
      }),
      deferredDone: (options) =>
        Effect.suspend(() => {
          const written = sql.exec(
            "INSERT OR IGNORE INTO wf_deferreds (execution_id, name, exit) VALUES (?, ?, ?)",
            options.executionId,
            options.deferredName,
            encodeExit(options.exit),
          ).rowsWritten;
          if (written === 0) return Effect.void;
          const wake = Effect.andThen(
            deferredState.deferredDone(options.executionId, options.deferredName),
            resume(options.executionId),
          );
          return Effect.flatMap(
            Effect.serviceOption(WorkflowEngine.WorkflowInstance),
            (instance) =>
              // A run completing its own deferred cannot wait for its own replay.
              Option.isSome(instance) && instance.value.executionId === options.executionId
                ? wake.pipe(Effect.forkIn(scope), Effect.asVoid)
                : wake,
          );
        }),
      scheduleClock: (workflow, options) =>
        Effect.suspend(() => {
          // A replay re-schedules clocks it passes; one that already fired stays done.
          const fired =
            sql
              .exec(
                "SELECT 1 FROM wf_deferreds WHERE execution_id = ? AND name = ?",
                options.executionId,
                options.clock.deferred.name,
              )
              .toArray().length > 0;
          if (fired) return Effect.void;
          sql.exec(
            "INSERT OR IGNORE INTO wf_clocks (execution_id, workflow, deferred, wake_at) VALUES (?, ?, ?, ?)",
            options.executionId,
            workflow._tag,
            options.clock.deferred.name,
            Date.now() + Duration.toMillis(options.clock.duration),
          );
          return armAlarm;
        }),
    };
    const engine = WorkflowEngine.makeUnsafe(encoded);

    const alarm = Effect.gen(function* () {
      const due = sql
        .exec<{ execution_id: string; workflow: string; deferred: string }>(
          "SELECT execution_id, workflow, deferred FROM wf_clocks WHERE wake_at <= ?",
          Date.now(),
        )
        .toArray();
      for (const clock of due) {
        sql.exec(
          "DELETE FROM wf_clocks WHERE execution_id = ? AND deferred = ?",
          clock.execution_id,
          clock.deferred,
        );
        // A clock's deferred carries `void`, so its encoded exit is a plain success.
        yield* encoded.deferredDone({
          workflowName: clock.workflow,
          executionId: clock.execution_id,
          deferredName: clock.deferred,
          exit: Exit.void,
        });
      }
      yield* armAlarm;
    });

    const recover = Effect.gen(function* () {
      const stranded = sql
        .exec<{ execution_id: string }>(
          "SELECT execution_id FROM wf_executions WHERE status = 'running'",
        )
        .toArray();
      for (const row of stranded) yield* resume(row.execution_id);
      yield* armAlarm;
    });

    const idle: Effect.Effect<void> = Effect.suspend(() => {
      const pending = [...running.values()].map((live) => Deferred.await(live.settled));
      if (pending.length === 0) return Effect.void;
      return Effect.andThen(Effect.all(pending, { discard: true }), idle);
    });

    const executions = Effect.sync(
      () =>
        sql
          .exec(
            "SELECT execution_id, workflow, status, runs, result, created_at, updated_at FROM wf_executions ORDER BY created_at DESC LIMIT 50",
          )
          .toArray() as ReadonlyArray<Record<string, unknown>>,
    );

    return { engine, alarm, recover, idle, executions } satisfies Control;
  });
