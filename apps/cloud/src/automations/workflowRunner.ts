import { _dispatcherBindingImpl } from "@cloudflare/dynamic-workflows";
import { AutomationRunner } from "@signalbox/automations/runner/AutomationRunner";
import { AutomationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import * as UserStore from "../user/UserStore.ts";

/**
 * Where a run's instance finds its code: the dispatcher (`automationWorkflow.ts`)
 * loads `automationId@version` from `userId`'s object.
 */
export interface RunMetadata {
  readonly userId: string;
  readonly automationId: string;
  readonly version: number;
}

/** About a second in all, inside the request that settled the step. */
const RETRY_EVENT = Schedule.exponential("100 millis");

const failed = (what: string) => (cause: unknown) =>
  new AutomationError({ message: `Couldn't ${what} the run's Workflow instance.`, cause });

/**
 * Runs on Cloudflare Workflows: one instance per run, its id the run id.
 * `@cloudflare/dynamic-workflows` puts the metadata beside the params, where
 * the dispatcher's entrypoint reads it back.
 */
export const layerWorkflows = (binding: Workflow | undefined) =>
  Layer.effect(
    AutomationRunner,
    Effect.gen(function* () {
      const users = yield* UserStore.UserStore;
      const requireBinding = Effect.suspend(() =>
        binding === undefined
          ? Effect.fail(
              new AutomationError({
                message: "This cloud has no Workflow binding for automations.",
              }),
            )
          : Effect.succeed(binding),
      );
      const instance = (runId: string) =>
        requireBinding.pipe(
          Effect.flatMap((workflows) =>
            Effect.tryPromise({ try: () => workflows.get(runId), catch: failed("reach") }),
          ),
        );
      return AutomationRunner.of({
        create: (run) =>
          Effect.gen(function* () {
            const workflows = yield* requireBinding;
            const profile = yield* users.profile.pipe(Effect.mapError(failed("start")));
            if (profile === null)
              return yield* new AutomationError({ message: "This object has no owner yet." });
            const metadata: RunMetadata = {
              userId: profile.id,
              automationId: run.automationId,
              version: run.version,
            };
            yield* Effect.tryPromise({
              try: () =>
                _dispatcherBindingImpl(() => workflows, { ...metadata }).create({
                  id: run.runId,
                  params: { runId: run.runId, input: run.input, trigger: run.trigger },
                }),
              catch: failed("start"),
            }).pipe(
              // A launch repeated after a cut-off request finds its instance already there.
              Effect.catch((error) => instance(run.runId).pipe(Effect.mapError(() => error))),
            );
          }).pipe(
            Effect.withSpan("AutomationRunner.create", {
              attributes: {
                "automation.id": run.automationId,
                "automation.version": run.version,
                "automation.run_id": run.runId,
              },
            }),
          ),
        sendEvent: (runId, type, payload) =>
          instance(runId).pipe(
            Effect.flatMap((handle) =>
              Effect.tryPromise({
                try: () => handle.sendEvent({ type, payload }),
                catch: failed("wake"),
              }),
            ),
            // The step is already settled in the object, so a lost event would strand the run.
            Effect.retry({ schedule: RETRY_EVENT, times: 3 }),
            Effect.withSpan("AutomationRunner.sendEvent", {
              attributes: { "automation.run_id": runId },
            }),
          ),
        // An instance that already ended can't be terminated, which is fine; anything else is logged.
        terminate: (runId) =>
          instance(runId).pipe(
            Effect.flatMap((handle) =>
              Effect.tryPromise({ try: () => handle.terminate(), catch: failed("stop") }),
            ),
            Effect.catchCause((cause) =>
              Effect.logWarning("Couldn't stop a run's Workflow instance", cause),
            ),
          ),
      });
    }),
  );
