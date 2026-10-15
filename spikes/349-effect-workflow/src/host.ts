/**
 * What one person's Durable Object hosts: the `effect/workflow` engine, the
 * automations and the Signalbox stand-in. Every entrypoint drives the runs it
 * woke until they suspend or finish, because workerd ties promises to the
 * request that made them; nothing stays in memory between entrypoints.
 *
 * Takes only the object's state, so the same code runs in the Durable Object
 * and in tests against a SQLite-backed fake.
 */
import { Context, Effect, Layer, Scope } from "effect";
import { WorkflowEngine } from "effect/workflow";

import { automations } from "./automations.ts";
import {
  AutomationRun,
  AutomationRunLayer,
  Signalbox,
  wakeAll,
  type StartRun,
} from "./automationWorkflow.ts";
import * as DurableObjectWorkflowEngine from "./DurableObjectWorkflowEngine.ts";
import { makeWorld, type Wake } from "./world.ts";

export type Host = Effect.Success<ReturnType<typeof makeHost>>;

export const makeHost = (
  state: DurableObjectState,
  options: { readonly deploy: string; readonly boot: string },
) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const control = yield* DurableObjectWorkflowEngine.make(state);
    let origin = "";
    const world = makeWorld(state.storage.sql, () => origin);
    world.deploy(options.deploy);

    const startRun = (run: StartRun): Effect.Effect<string, never, WorkflowEngine.WorkflowEngine> =>
      Effect.gen(function* () {
        const automation = automations.get(run.automation);
        if (!automation) return yield* Effect.die(new Error(`No automation "${run.automation}".`));
        const payload = {
          runId: crypto.randomUUID(),
          automation: automation.slug,
          version: automation.version,
          input: (run.input ?? null) as never,
          trigger: (run.trigger ?? null) as never,
        };
        const executionId = yield* AutomationRun.executionId(payload);
        world.recordRun({
          ...payload,
          executionId,
          restartedFrom: run.restartedFrom ?? null,
          deploy: options.deploy,
        });
        // A new run is never a child of the run that started it.
        yield* AutomationRun.execute(payload, { discard: true }).pipe(
          Effect.updateContext((context: Context.Context<WorkflowEngine.WorkflowEngine>) =>
            Context.omit(WorkflowEngine.WorkflowInstance)(context),
          ),
          Effect.orDie,
        );
        return payload.runId;
      });

    yield* Layer.buildWithScope(
      AutomationRunLayer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(WorkflowEngine.WorkflowEngine, control.engine),
            Layer.succeed(Signalbox, Signalbox.of({ world, wake: wakeAll, startRun })),
          ),
        ),
      ),
      scope,
    );

    let recovered = false;
    /** Runs `effect` against the engine, then waits until every run it woke has parked or finished. */
    const drive = <A, E>(effect: Effect.Effect<A, E, WorkflowEngine.WorkflowEngine>) =>
      Effect.gen(function* () {
        if (!recovered) {
          recovered = true;
          yield* control.recover;
        }
        const result = yield* Effect.provideService(
          effect,
          WorkflowEngine.WorkflowEngine,
          control.engine,
        );
        yield* control.idle;
        return result;
      });

    /** Hands wakes to their runs; `wakes` runs first, so a validation error wakes nothing. */
    const wake = (wakes: () => ReadonlyArray<Wake>) =>
      drive(Effect.suspend(() => wakeAll(wakes())).pipe(Effect.as({ ok: true as const })));

    return {
      setOrigin: (value: string) => {
        origin = value;
      },
      start: (run: StartRun) => drive(startRun(run)),
      answer: (askId: number, answer: { choice?: string; values?: Record<string, unknown> }) =>
        wake(() => [world.answerAsk(askId, answer)]),
      emit: (event: string, fields: Record<string, unknown>) =>
        wake(() => world.emit(event, fields)),
      finishTurn: (
        threadId: string,
        text: string,
        pullRequest: { number: number; url: string } | null,
      ) => wake(() => [world.finishTurn(threadId, text, pullRequest)]),
      hookCalled: (hookId: string, method: string, body: unknown) =>
        wake(() => world.hookCalled(hookId, method, body)),
      alarm: drive(control.alarm),
      status: drive(
        Effect.gen(function* () {
          return {
            deploy: options.deploy,
            boot: options.boot,
            automations: [...automations.values()].map(({ slug, name, version }) => ({
              slug,
              name,
              version: version.slice(0, 12),
            })),
            executions: yield* control.executions,
            alarm: yield* Effect.promise(() => state.storage.getAlarm()),
            ...world.status(),
          };
        }),
      ),
    };
  });

/** Builds a host whose scope lives as long as the object; workerd has no teardown hook to close it. */
export const makeHostForObject = (
  state: DurableObjectState,
  options: { readonly deploy: string; readonly boot: string },
) => Effect.flatMap(Scope.make(), (scope) => makeHost(state, options).pipe(Scope.provide(scope)));
