import { OrchestratorMcpFailure, type AutomationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as SecretRequests from "../../secrets/SecretRequests.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import { readCaller, type Caller } from "../../mcp/threadAccess.ts";
import { callerDefaults, saveForCaller, withinLimits } from "../callerAccess.ts";
import { builtInById } from "../defaults/registry.ts";
import { EXAMPLES } from "../skill/content/examples.ts";
import { SKILL_TOPICS, skillReference } from "../skill/files.ts";
import * as WorkflowEngine from "../WorkflowEngine.ts";
import { builtInReadResult } from "./builtIns.ts";
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

/**
 * Runs `use` for a thread or client allowed to use orchestration. Each tool's
 * declaration decides the rest: `writes` also refuses read-only clients and
 * needs the caller's run to be live. Under `writes` the caller loads twice,
 * since declarations don't hand it over; these tools are rare enough not to care.
 */
const asCaller = <A, R>(
  use: (caller: Caller) => Effect.Effect<A, AutomationError | OrchestratorMcpFailure, R>,
) => readCaller().pipe(Effect.flatMap(use), Effect.mapError(toMcpFailure));

export const layer = McpToolAccess.toLayer(
  AutomationToolkit,
  Effect.gen(function* () {
    const engine = yield* WorkflowEngine.WorkflowEngine;
    const secretRequests = yield* SecretRequests.SecretRequests;
    return {
      automation_reference: McpToolAccess.reads(({ topic }) => {
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
      }),
      automation_validate: McpToolAccess.reads(({ source }) =>
        asCaller(() => Effect.sync(() => validateResult(engine.validate(source)))),
      ),
      automation_save: McpToolAccess.writes((input) =>
        asCaller((caller) => saveForCaller(caller, input)).pipe(Effect.map(saveResult)),
      ),
      automation_list: McpToolAccess.reads(() =>
        asCaller(() => Effect.all([engine.list(), engine.builtIns])).pipe(
          Effect.map(([automations, builtIns]) => ({
            automations: automations.map(automationSummary),
            builtIns,
          })),
        ),
      ),
      automation_read: McpToolAccess.reads(({ automationId }) => {
        const builtIn = builtInById(automationId);
        return builtIn
          ? asCaller(() => Effect.sync(() => builtInReadResult(builtIn, engine.validate)))
          : asCaller(() => engine.get(automationId)).pipe(Effect.map(readResult));
      }),
      automation_run: McpToolAccess.writes(({ automationId, input, attach, projectId }) =>
        asCaller((caller) =>
          Effect.gen(function* () {
            // Where a built-in runs: the attached thread's project, else the one named, else the caller's.
            const place = attach
              ? (yield* caller.threads
                  .getThreadShell(attach.threadId)
                  .pipe(Effect.orElseSucceed(() => null)))?.projectId
              : (projectId ?? caller.caller?.projectId);
            return yield* engine.startRun({
              automationId,
              input,
              trigger: "manual",
              authorize: withinLimits(caller.limits),
              attach,
              projectId: place,
              builtInDefaults: place ? yield* callerDefaults(caller, place) : undefined,
            });
          }),
        ).pipe(Effect.map((run) => ({ run: runSummary(run) }))),
      ),
      automation_customize: McpToolAccess.writes(({ automationId, projectId }) =>
        asCaller((caller) =>
          Effect.gen(function* () {
            const place = projectId ?? caller.caller?.projectId;
            if (!place)
              return yield* new OrchestratorMcpFailure({
                code: "target_required",
                message: "Pass projectId: you're not calling from a Signalbox thread.",
              });
            return yield* engine.customize(automationId, {
              projectId: place,
              defaults: yield* callerDefaults(caller, place),
            });
          }),
        ).pipe(Effect.map((automation) => ({ automation: automationSummary(automation) }))),
      ),
      automation_run_read: McpToolAccess.reads(({ runId }) =>
        asCaller(() => engine.getRun(runId)).pipe(Effect.map(runReadResult)),
      ),
      automation_set_enabled: McpToolAccess.writes(({ automationId, enabled }) =>
        asCaller(() => engine.setEnabled(automationId, enabled)).pipe(
          Effect.map((automation) => ({ automation: automationSummary(automation) })),
        ),
      ),
      automation_cancel_run: McpToolAccess.writes(({ runId }) =>
        asCaller(() => engine.cancelRun(runId)).pipe(Effect.as({})),
      ),
      automation_run_retry: McpToolAccess.writes(({ runId, version }) =>
        asCaller(({ limits }) =>
          engine.retryRun({ runId, version, authorize: withinLimits(limits) }),
        ).pipe(Effect.map((run) => ({ run: runSummary(run) }))),
      ),
      automation_publish: McpToolAccess.writes(({ automationId }) =>
        asCaller(() => engine.publish(automationId)).pipe(
          Effect.map((automation) => ({ automation: automationSummary(automation) })),
        ),
      ),
      automation_discard_draft: McpToolAccess.writes(({ automationId }) =>
        asCaller(() => engine.discardDraft(automationId)).pipe(
          Effect.map((automation) => ({ automation: automationSummary(automation) })),
        ),
      ),
      automation_delete: McpToolAccess.writes(({ automationId }) =>
        asCaller(() => engine.remove(automationId)).pipe(Effect.as({})),
      ),
      automation_emit: McpToolAccess.writes((input) =>
        asCaller(() => engine.emit(input)).pipe(Effect.map((woke) => ({ woke }))),
      ),
      automation_set_webhook_secret: McpToolAccess.writes(({ automationId, secretRef }) =>
        asCaller(({ limits }) =>
          Effect.gen(function* () {
            const { automation } = yield* engine.get(automationId);
            // The ref was entered in a thread of the automation's project.
            const secret = yield* secretRequests
              .consume({ ref: secretRef, projectId: automation.projectId })
              .pipe(
                Effect.mapError(
                  (error) =>
                    new OrchestratorMcpFailure({ code: "invalid_request", message: error.message }),
                ),
              );
            return yield* engine.setWebhookSecret({
              automationId,
              secret,
              authorize: withinLimits(limits),
            });
          }),
        ).pipe(Effect.map((automation) => ({ automation: automationSummary(automation) }))),
      ),
    };
  }),
);
