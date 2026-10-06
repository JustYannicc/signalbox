import { OrchestratorMcpFailure, type AutomationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { readCaller, readMutationCaller, type Caller } from "../../mcp/threadAccess.ts";
import { saveForCaller, withinLimits } from "../callerAccess.ts";
import { EXAMPLES } from "../skill/content/examples.ts";
import { SKILL_TOPICS, skillReference } from "../skill/files.ts";
import * as WorkflowEngine from "../WorkflowEngine.ts";
import {
  automationSummary,
  readResult,
  runReadResult,
  runSummary,
  saveResult,
  validateResult,
} from "./summaries.ts";
import { AutomationToolkit } from "./tools.ts";

const toMcpFailure = (error: AutomationError | OrchestratorMcpFailure) =>
  error._tag === "AutomationError"
    ? new OrchestratorMcpFailure({ code: "invalid_request", message: error.message })
    : error;

/** Reads require a thread or client allowed to use orchestration; changes require its live run. */
const reading = <A, R>(
  use: (caller: Caller) => Effect.Effect<A, AutomationError | OrchestratorMcpFailure, R>,
) => readCaller().pipe(Effect.flatMap(use), Effect.mapError(toMcpFailure));
const changing = <A, R>(
  use: (caller: Caller) => Effect.Effect<A, AutomationError | OrchestratorMcpFailure, R>,
) => readMutationCaller().pipe(Effect.flatMap(use), Effect.mapError(toMcpFailure));

export const AutomationToolkitHandlersLive = AutomationToolkit.toLayer(
  Effect.gen(function* () {
    const engine = yield* WorkflowEngine.WorkflowEngine;
    return {
      automation_reference: ({ topic }) => {
        const reference = skillReference(topic);
        return reference === null
          ? Effect.fail(
              new OrchestratorMcpFailure({
                code: "invalid_request",
                message: `There's no reference topic "${topic}". Topics: ${[
                  ...Object.keys(SKILL_TOPICS),
                  ...Object.keys(EXAMPLES),
                ].join(", ")}.`,
              }),
            )
          : Effect.succeed({ reference });
      },
      automation_validate: ({ source }) =>
        reading(() => Effect.sync(() => validateResult(engine.validate(source)))),
      automation_save: (input) =>
        changing((caller) => saveForCaller(caller, input)).pipe(Effect.map(saveResult)),
      automation_list: () =>
        reading(() => engine.list()).pipe(
          Effect.map((automations) => ({ automations: automations.map(automationSummary) })),
        ),
      automation_read: ({ automationId }) =>
        reading(() => engine.get(automationId)).pipe(Effect.map(readResult)),
      automation_run: ({ automationId, input }) =>
        changing(({ limits }) =>
          engine.startRun({
            automationId,
            input,
            trigger: "manual",
            authorize: withinLimits(limits),
          }),
        ).pipe(Effect.map((run) => ({ run: runSummary(run) }))),
      automation_run_read: ({ runId }) =>
        reading(() => engine.getRun(runId)).pipe(Effect.map(runReadResult)),
      automation_set_enabled: ({ automationId, enabled }) =>
        changing(() => engine.setEnabled(automationId, enabled)).pipe(
          Effect.map((automation) => ({ automation: automationSummary(automation) })),
        ),
      automation_cancel_run: ({ runId }) =>
        changing(() => engine.cancelRun(runId)).pipe(Effect.as({})),
      automation_run_retry: ({ runId, version }) =>
        changing(({ limits }) =>
          engine.retryRun({ runId, version, authorize: withinLimits(limits) }),
        ).pipe(Effect.map((run) => ({ run: runSummary(run) }))),
      automation_publish: ({ automationId }) =>
        changing(() => engine.publish(automationId)).pipe(
          Effect.map((automation) => ({ automation: automationSummary(automation) })),
        ),
      automation_discard_draft: ({ automationId }) =>
        changing(() => engine.discardDraft(automationId)).pipe(
          Effect.map((automation) => ({ automation: automationSummary(automation) })),
        ),
      automation_delete: ({ automationId }) =>
        changing(() => engine.remove(automationId)).pipe(Effect.as({})),
      automation_emit: (input) =>
        changing(() => engine.emit(input)).pipe(Effect.map((woke) => ({ woke }))),
    };
  }),
);
