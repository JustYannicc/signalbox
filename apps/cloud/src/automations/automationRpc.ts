import {
  AUTOMATION_WS_METHODS,
  AutomationError,
  ThreadId,
  type AutomationRpcs,
  type ModelSelection,
  type ProjectId,
} from "@t3tools/contracts";
import { AutomationThreads } from "@signalbox/automations/host";
import { fail } from "@signalbox/automations/errors";
import * as WorkflowEngine from "@signalbox/automations/WorkflowEngine";
import * as Effect from "effect/Effect";
import type * as Rpc from "effect/rpc/Rpc";
import * as Stream from "effect/Stream";

import { CloudAutomations } from "./CloudAutomations.ts";
import { acceptCompiled, COMPILE_WHERE } from "./cloudCompiler.ts";
import { GitHubWebhooks } from "../github/GitHubWebhooks.ts";

/**
 * The automation RPCs a client calls on the user's object: the same contract
 * the self-hosted server serves (`apps/server/src/workflows/rpcHandlers.ts`),
 * each calling one engine method and then flushing, so what it started
 * here is done before the request ends. Validating and saving take what the
 * caller compiled (`compiled`), since the cloud can't compile. Saves resolve
 * omitted cron zones into scheduling metadata without changing the source or code. Executor
 * connections aren't in the cloud yet and say so.
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

const compileWhere = fail(COMPILE_WHERE);

/**
 * `newThreadModel` is what a new thread of the person's starts on, which is
 * what an automation they save runs with: there's no calling thread to take it from.
 */
export const makeAutomationHandlers = Effect.fn("makeAutomationHandlers")(function* (options: {
  readonly newThreadModel: (projectId?: ProjectId) => Effect.Effect<ModelSelection | null>;
  /**
   * Whether publishing vouches for the reviewed version: only a person's app
   * session can say a person looked at it. Keys, the CLI and MCP may be an
   * agent holding the person's credential.
   */
  readonly personReviews: boolean;
}) {
  const engine = yield* WorkflowEngine.WorkflowEngine;
  const automations = yield* CloudAutomations;
  const threads = yield* AutomationThreads;
  const github = yield* GitHubWebhooks;
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
    [METHODS.automationsRotateWebhook]: (input: Payload<typeof METHODS.automationsRotateWebhook>) =>
      flushed(engine.rotateWebhook(input.automationId)),
    [METHODS.automationsSetWebhookSecret]: (
      input: Payload<typeof METHODS.automationsSetWebhookSecret>,
    ) => flushed(engine.setWebhookSecret(input)),
    [METHODS.automationsGitHubSubscriptions]: (
      _input: Payload<typeof METHODS.automationsGitHubSubscriptions>,
    ) => github.status.pipe(Effect.map((subscriptions) => ({ subscriptions }))),
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
    // Compiling needs oxc, which can't run in workerd; the caller compiles.
    [METHODS.automationsValidate]: (input: Payload<typeof METHODS.automationsValidate>) =>
      input.compiled === undefined
        ? compileWhere
        : acceptCompiled(input.compiled).pipe(
            Effect.map((compiled) => ({ ok: true as const, graph: compiled.graph })),
          ),
    [METHODS.automationsSave]: (input: Payload<typeof METHODS.automationsSave>) =>
      about({
        "folder.id": input.projectId,
        ...(input.automationId ? { "automation.id": input.automationId } : {}),
      }).pipe(Effect.andThen(automations.save(input, options.newThreadModel))),
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
    // People publish in the app, vouching for the version they saw; the public API publishes and vouches for nothing.
    [METHODS.automationsPublish]: (input: Payload<typeof METHODS.automationsPublish>) =>
      flushed(
        engine.publish(
          input.automationId,
          options.personReviews && input.version !== undefined
            ? { version: input.version }
            : undefined,
        ),
      ),
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
