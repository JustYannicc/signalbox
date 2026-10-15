import {
  AUTOMATION_WS_METHODS,
  AutomationError,
  ThreadId,
  type AutomationRpcs,
} from "@t3tools/contracts";
import { AutomationThreads } from "@signalbox/automations/host";
import * as WorkflowEngine from "@signalbox/automations/WorkflowEngine";
import * as Effect from "effect/Effect";
import type * as Rpc from "effect/rpc/Rpc";
import * as Stream from "effect/Stream";

import { CloudAutomations } from "./CloudAutomations.ts";

/**
 * The automation RPCs a client calls on the user's object: the same contract
 * the self-hosted server serves (`apps/server/src/workflows/rpcHandlers.ts`),
 * each calling one engine method and then flushing, so what it started
 * here is done before the request ends. Executor connections and webhooks aren't
 * in the cloud yet and say so.
 */

export const AUTOMATION_METHODS = Object.values(AUTOMATION_WS_METHODS);

const METHODS = AUTOMATION_WS_METHODS;

type Payload<Tag extends string> = Rpc.Payload<
  Rpc.ExtractTag<(typeof AutomationRpcs)[number], Tag>
>;

const NOT_CONNECTED = {
  configured: false,
  source: null,
  url: null,
  services: [],
  error: null,
} as const;

const notYet = (what: string) =>
  Effect.fail(
    new AutomationError({ message: `${what} aren't available in cloud automations yet.` }),
  );

export const makeAutomationHandlers = Effect.gen(function* () {
  const engine = yield* WorkflowEngine.WorkflowEngine;
  const automations = yield* CloudAutomations;
  const threads = yield* AutomationThreads;
  const flushed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.tap(() => automations.flush));
  /** Spans name the automation or run, never what's in them. */
  const about = (attributes: Readonly<Record<string, string>>) =>
    Effect.annotateCurrentSpan(attributes);

  return {
    [METHODS.automationsSubscribe]: (_input: Payload<typeof METHODS.automationsSubscribe>) =>
      engine.subscribeList().pipe(Stream.map((list) => ({ automations: list }))),
    [METHODS.automationsSubscribeNotices]: (
      _input: Payload<typeof METHODS.automationsSubscribeNotices>,
    ) => Stream.unwrap(engine.subscribeNotices),
    [METHODS.automationsSubscribeOne]: (input: Payload<typeof METHODS.automationsSubscribeOne>) =>
      engine.subscribeAutomation(input.automationId),
    [METHODS.automationsSubscribeRun]: (input: Payload<typeof METHODS.automationsSubscribeRun>) =>
      engine.subscribeRun(input.runId),
    [METHODS.automationsSetEnabled]: (input: Payload<typeof METHODS.automationsSetEnabled>) =>
      about({ "automation.id": input.automationId }).pipe(
        Effect.andThen(flushed(engine.setEnabled(input.automationId, input.enabled))),
      ),
    [METHODS.automationsDelete]: (input: Payload<typeof METHODS.automationsDelete>) =>
      flushed(engine.remove(input.automationId)).pipe(Effect.as({})),
    [METHODS.automationsRotateWebhook]: (
      _input: Payload<typeof METHODS.automationsRotateWebhook>,
    ) => notYet("Webhooks"),
    [METHODS.automationsSetWebhookSecret]: (
      _input: Payload<typeof METHODS.automationsSetWebhookSecret>,
    ) => notYet("Webhooks"),
    [METHODS.automationsRunNow]: (input: Payload<typeof METHODS.automationsRunNow>) =>
      flushed(
        Effect.gen(function* () {
          // A person starting a built-in on a thread runs it with that thread's model and modes.
          const shell = input.attach
            ? yield* threads.getThreadShell(ThreadId.make(input.attach.threadId))
            : null;
          return yield* engine.startRun({
            automationId: input.automationId,
            input: input.input,
            trigger: "manual",
            attach: input.attach,
            ...(shell
              ? {
                  projectId: shell.projectId,
                  builtInDefaults: {
                    modelSelection: shell.modelSelection,
                    runtimeMode: shell.runtimeMode,
                    interactionMode: shell.interactionMode,
                  },
                }
              : {}),
          });
        }),
      ),
    [METHODS.automationsCustomize]: (_input: Payload<typeof METHODS.automationsCustomize>) =>
      notYet("Customizing built-ins from the app (an agent's automation_customize works)"),
    [METHODS.automationsStopAttached]: (input: Payload<typeof METHODS.automationsStopAttached>) =>
      flushed(engine.cancelAttached(input.threadId)).pipe(
        Effect.map((cancelled) => ({ cancelled })),
      ),
    [METHODS.automationsCancelRun]: (input: Payload<typeof METHODS.automationsCancelRun>) =>
      about({ "automation.run_id": input.runId }).pipe(
        Effect.andThen(flushed(engine.cancelRun(input.runId))),
        Effect.as({}),
      ),
    [METHODS.automationsRetryRun]: (input: Payload<typeof METHODS.automationsRetryRun>) =>
      flushed(engine.retryRun({ runId: input.runId, version: input.version })),
    [METHODS.automationsPublish]: (input: Payload<typeof METHODS.automationsPublish>) =>
      flushed(engine.publish(input.automationId)),
    [METHODS.automationsDiscardDraft]: (input: Payload<typeof METHODS.automationsDiscardDraft>) =>
      flushed(engine.discardDraft(input.automationId)),
    [METHODS.automationsAnswer]: (input: Payload<typeof METHODS.automationsAnswer>) =>
      about({ "automation.run_id": input.runId }).pipe(
        Effect.andThen(flushed(engine.answer(input))),
        Effect.as({}),
      ),
    [METHODS.automationsConnectionStatus]: (
      _input: Payload<typeof METHODS.automationsConnectionStatus>,
    ) => Effect.succeed(NOT_CONNECTED),
    [METHODS.automationsConnect]: (_input: Payload<typeof METHODS.automationsConnect>) =>
      notYet("Executor connections"),
    [METHODS.automationsDisconnect]: (_input: Payload<typeof METHODS.automationsDisconnect>) =>
      Effect.succeed(NOT_CONNECTED),
  };
});
