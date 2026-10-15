/**
 * Signalbox automations as one `effect/workflow` workflow.
 *
 * Automations are data (a folder's compiled files), not code deployed with
 * the engine, so there is one generic workflow whose payload names the
 * automation and pins the version it started on. Its body runs the compiled
 * file through the guest receiver; every `w.<verb>` call becomes an
 * `Activity`, a `DurableDeferred` or a `DurableClock`, named by the step's
 * call-site key. Replay is effect/workflow's: on each wake the body runs from
 * the top and journaled steps answer immediately.
 */
import { Cause, Context, Duration, Effect, Exit, Fiber, Schema } from "effect";
import { Activity, DurableClock, DurableDeferred, Workflow, WorkflowEngine } from "effect/workflow";

import { automations } from "./automations.ts";
import { runGuest, type GuestOutcome, type StepHost } from "./guest.ts";
import type { AskOptions, Wake, World } from "./world.ts";

export class StepFailed extends Schema.TaggedError<StepFailed>()("StepFailed", {
  message: Schema.String,
}) {}
export class AutomationFailed extends Schema.TaggedError<AutomationFailed>()("AutomationFailed", {
  message: Schema.String,
}) {}

export const AutomationRun = Workflow.make("SignalboxAutomation", {
  payload: {
    runId: Schema.String,
    automation: Schema.String,
    /** The source hash the run started on; a deploy without it can't resume the run. */
    version: Schema.String,
    input: Schema.Json,
    trigger: Schema.Json,
  },
  success: Schema.Json,
  error: AutomationFailed,
  idempotencyKey: ({ runId }) => runId,
});

export interface StartRun {
  readonly automation: string;
  readonly input: unknown;
  readonly trigger?: unknown;
  readonly restartedFrom?: string | null;
}

export class Signalbox extends Context.Service<
  Signalbox,
  {
    readonly world: World;
    /** Completes the deferreds an event, answer or finished turn satisfied. */
    readonly wake: (
      wakes: ReadonlyArray<Wake>,
    ) => Effect.Effect<void, never, WorkflowEngine.WorkflowEngine>;
    readonly startRun: (
      run: StartRun,
    ) => Effect.Effect<string, never, WorkflowEngine.WorkflowEngine>;
  }
>()("spike/Signalbox") {}

/** Completes any deferred by its token; the token carries the run and the deferred's name. */
export const Signal = DurableDeferred.make("signal", { success: Schema.Json });

export const wakeAll = (wakes: ReadonlyArray<Wake>) =>
  Effect.forEach(
    wakes,
    ({ token, value }) =>
      DurableDeferred.done(Signal, {
        token: token as DurableDeferred.Token,
        exit: Exit.succeed(value as Schema.Json),
      }),
    { discard: true },
  );

interface Step {
  readonly runId: string;
  readonly key: string;
  readonly verb: string;
  readonly label: string;
  readonly args: ReadonlyArray<unknown>;
}

type DurationInput = { seconds?: number; minutes?: number; hours?: number; days?: number };
const toDuration = (input: DurationInput) =>
  Duration.seconds(
    (input.seconds ?? 0) +
      (input.minutes ?? 0) * 60 +
      (input.hours ?? 0) * 3600 +
      (input.days ?? 0) * 86400,
  );

const failed = (error: unknown) =>
  new StepFailed({ message: error instanceof Error ? error.message : String(error) });

/** Steps journal JSON; `undefined` is journaled as `null`, as today. */
const activity = <R>(name: string, execute: Effect.Effect<unknown, StepFailed, R>) =>
  Activity.make({
    name,
    success: Schema.Json,
    error: StepFailed,
    execute: Effect.map(execute, (value) => (value ?? null) as Schema.Json),
  });

const worldStep = <A>(f: (world: World) => A) =>
  Effect.flatMap(Signalbox, ({ world }) => Effect.try({ try: () => f(world), catch: failed }));

/** One-shot steps run once and journal their result. */
const once = (step: Step) =>
  activity(
    step.key,
    Effect.gen(function* () {
      const { wake } = yield* Signalbox;
      const result = yield* worldStep((world) =>
        world.runStep(step.runId, step.key, step.verb, step.label, step.args),
      );
      yield* wake(result.wakes);
      return result.value;
    }),
  );

/** Waits for a deferred, or `onTimeout` after `timeout`; the winner is journaled under the step key. */
const awaitWithin = (
  step: Step,
  deferred: DurableDeferred.DurableDeferred<typeof Schema.Json>,
  timeout?: DurationInput,
) =>
  timeout === undefined
    ? DurableDeferred.await(deferred)
    : DurableDeferred.raceAll({
        name: step.key,
        success: Schema.Json,
        error: Schema.Never,
        effects: [
          DurableDeferred.await(deferred),
          DurableClock.sleep({ name: `${step.key}/timeout`, duration: toDuration(timeout) }).pipe(
            Effect.as({ "~timedOut": true } as Schema.Json),
          ),
        ],
      });

const timedOut = (value: unknown) =>
  typeof value === "object" && value !== null && "~timedOut" in value;

const ask = (step: Step) =>
  Effect.gen(function* () {
    const options = (step.args[0] ?? {}) as AskOptions & {
      timeout?: DurationInput;
      onTimeout?: string;
    };
    const answer = DurableDeferred.make(`${step.key}/answer`, { success: Schema.Json });
    const token = yield* DurableDeferred.token(answer);
    yield* activity(
      `${step.key}/open`,
      worldStep((world) =>
        world.openAsk({ token, runId: step.runId, key: step.key, label: step.label, options }),
      ),
    );
    const value = yield* awaitWithin(step, answer, options.timeout);
    if (!timedOut(value)) return value;
    if (!options.onTimeout || options.onTimeout === "fail")
      return yield* new StepFailed({ message: "Nobody answered in time." });
    return options.fields ? { choice: options.onTimeout, values: {} } : options.onTimeout;
  });

const waitFor = (step: Step) =>
  Effect.gen(function* () {
    const options = (step.args[0] ?? {}) as {
      on?: string | string[];
      where?: unknown;
      event?: string;
      timeout?: DurationInput;
    };
    const arrived = DurableDeferred.make(`${step.key}/event`, { success: Schema.Json });
    const token = yield* DurableDeferred.token(arrived);
    const on = options.event ? `event:${options.event}` : (options.on ?? "*");
    yield* activity(
      `${step.key}/listen`,
      worldStep((world) =>
        world.listen({ token, runId: step.runId, key: step.key, on, where: options.where }),
      ),
    );
    const value = yield* awaitWithin(step, arrived, options.timeout);
    if (timedOut(value)) {
      // A timed-out wait stops listening, so the next wait gets the next event.
      yield* activity(
        `${step.key}/unlisten`,
        worldStep((world) => world.unlisten(token)),
      );
      return null;
    }
    return options.event ? ((value as { payload?: unknown }).payload ?? null) : value;
  });

const agent = (step: Step) =>
  Effect.gen(function* () {
    const options = (step.args[0] ?? {}) as { prompt: string; thread?: string };
    const turn = DurableDeferred.make(`${step.key}/turn`, { success: Schema.Json });
    const token = yield* DurableDeferred.token(turn);
    yield* activity(
      `${step.key}/start`,
      worldStep((world) =>
        world.startAgent({
          token,
          runId: step.runId,
          key: step.key,
          prompt: options.prompt,
          ...(options.thread ? { thread: options.thread } : {}),
        }),
      ),
    );
    return yield* DurableDeferred.await(turn);
  });

const sleep = (step: Step) => {
  const spec = (step.args[0] ?? {}) as DurationInput & { until?: string };
  const duration = spec.until
    ? Duration.millis(Math.max(0, Date.parse(spec.until) - Date.now()))
    : toDuration(spec);
  return DurableClock.sleep({ name: step.key, duration }).pipe(Effect.as(null));
};

const start = (step: Step) =>
  activity(
    step.key,
    Effect.gen(function* () {
      const { startRun } = yield* Signalbox;
      const [automation, input] = step.args as [string, unknown];
      return { runId: yield* startRun({ automation, input }) };
    }),
  );

const http = (step: Step) =>
  activity(
    step.key,
    Effect.tryPromise({
      try: async () => {
        const spec = (typeof step.args[0] === "string" ? { url: step.args[0] } : step.args[0]) as {
          url: string;
          method?: string;
          body?: unknown;
        };
        const response = await fetch(spec.url, {
          method: spec.method ?? "GET",
          ...(spec.body === undefined
            ? {}
            : { body: JSON.stringify(spec.body), headers: { "content-type": "application/json" } }),
        });
        const text = await response.text();
        return {
          status: response.status,
          ok: response.ok,
          headers: Object.fromEntries(response.headers),
          body: text.slice(0, 10_000),
        };
      },
      catch: failed,
    }),
  );

const stepEffect = (
  step: Step,
): Effect.Effect<
  unknown,
  StepFailed,
  Signalbox | WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance
> => {
  switch (step.verb) {
    case "ask":
      return ask(step);
    case "waitFor":
      return waitFor(step);
    case "agent":
      return agent(step);
    case "sleep":
      return sleep(step);
    case "hook":
      return activity(
        step.key,
        worldStep((world) => world.createHook(step.runId, step.key)),
      );
    case "start":
      return start(step);
    case "http":
      return http(step);
    case "run":
      return Effect.fail(
        new StepFailed({ message: "w.run needs the runner VM, which the spike doesn't have." }),
      );
    default:
      return once(step);
  }
};

const messageOf = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return error instanceof Error
    ? error.message
    : typeof error === "object" && error !== null && "message" in error
      ? String(error.message)
      : String(error);
};

export const AutomationRunLayer = AutomationRun.toLayer(
  Effect.fnUntraced(function* (payload) {
    const automation = automations.get(payload.automation);
    if (!automation)
      return yield* new AutomationFailed({
        message: `No automation "${payload.automation}" in this deploy.`,
      });
    if (automation.version !== payload.version) {
      return yield* new AutomationFailed({
        message: `This run is pinned to version ${payload.version.slice(0, 12)} of "${automation.name}", which this deploy doesn't have.`,
      });
    }
    const context = yield* Effect.context<
      Signalbox | WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance
    >();
    const instance = Context.get(context, WorkflowEngine.WorkflowInstance);
    const { world, startRun } = Context.get(context, Signalbox);

    const outcome = yield* Effect.callback<GuestOutcome, AutomationFailed>((resume) => {
      const fibers = new Set<Fiber.Fiber<unknown, StepFailed>>();
      let parked = false;
      const host: StepHost = {
        step: (key, verb, label, args) =>
          new Promise((resolve, reject) => {
            if (parked) return;
            const fiber = Effect.runForkWith(context)(
              stepEffect({ runId: payload.runId, key, verb, label, args }),
            );
            fibers.add(fiber);
            fiber.addObserver((exit) => {
              fibers.delete(fiber);
              if (Exit.isSuccess(exit)) return resolve(exit.value);
              if (Cause.hasInterruptsOnly(exit.cause)) {
                // The step parked (or the run was preempted): the run suspends and
                // this promise never settles. The next wake replays from the top.
                if (!parked) {
                  parked = true;
                  resume(instance.suspended ? Workflow.suspend(instance) : Effect.interrupt);
                }
                return;
              }
              reject(new Error(messageOf(exit.cause)));
            });
          }),
        mark: (key, value) => world.mark(payload.runId, key, value),
      };
      runGuest(automation.definition, host, payload.input, payload.trigger).then(
        (result) => resume(Effect.succeed(result)),
        (error: unknown) =>
          resume(
            Effect.fail(
              new AutomationFailed({
                message: error instanceof Error ? error.message : String(error),
              }),
            ),
          ),
      );
      return Effect.sync(() => {
        parked = true;
        for (const fiber of fibers) fiber.interruptUnsafe();
      });
    });

    if (!outcome.restart) return outcome.output as Schema.Json;
    // `w.restart`: continue as a new run on the latest version, as today.
    const next = yield* Activity.make({
      name: "~restart",
      success: Schema.String,
      execute: startRun({
        automation: payload.automation,
        input: outcome.input,
        trigger: payload.trigger,
        restartedFrom: payload.runId,
      }),
    });
    return { restartedAs: next };
  }),
);
