import {
  CommandId,
  ThreadId,
  automationAskAnswerFromValue,
  resolveAutomationAskAnswer,
  type AutomationError,
} from "@t3tools/contracts";
import type {
  SignalboxAsk,
  SignalboxAskAnswerCommand,
  SignalboxAskAnswerer,
} from "@t3tools/contracts/signalboxAsks";
import * as Effect from "effect/Effect";
import { applyAskCommand } from "@t3tools/shared/signalboxAsks";

import { askJsonValue, automationAskRecord, encodeAsk } from "./askRecord.ts";
import { fail } from "./errors.ts";
import { stepAsk } from "./columns.ts";
import type { Settlement } from "./engineTypes.ts";
import type { AutomationThreads } from "./host.ts";
import { asRecord, fromJson } from "./json.ts";
import type { RunLinkStore } from "./runLinkStore.ts";
import { nowIso } from "./time.ts";
import type { AutomationRow, StepRow, WorkflowStore } from "./WorkflowStore.ts";

export interface AutomationAnswerContext {
  readonly answeredBy?: SignalboxAskAnswerer;
  readonly comment?: string;
  readonly command?: typeof SignalboxAskAnswerCommand.Type;
}

export const makeAsks = (deps: {
  readonly store: WorkflowStore;
  readonly links: RunLinkStore;
  readonly threads: AutomationThreads["Service"];
  readonly complete: (
    runId: string,
    key: string,
    outcome: Settlement,
    context?: AutomationAnswerContext,
  ) => Effect.Effect<boolean, AutomationError>;
  readonly runChanged: (runId: string, summary: boolean) => Effect.Effect<void, AutomationError>;
}) => {
  const { store, links, threads } = deps;
  const originatingThread = (runId: string): Effect.Effect<string | null, AutomationError> =>
    Effect.gen(function* () {
      const link = yield* links.getLink(runId);
      if (link?.thread_id) return link.thread_id;
      const run = yield* store.getRun(runId);
      if (!run) return null;
      const automation = yield* store.getAutomation(run.automation_id);
      const input = asRecord(fromJson(run.input_json));
      const trigger = asRecord(fromJson(run.trigger_json));
      const id = trigger.originThreadId ?? input.threadId ?? asRecord(trigger.attach).threadId;
      if (typeof id === "string" && id.trim()) {
        const thread = yield* threads.getThreadShell(ThreadId.make(id));
        if (thread?.projectId === automation?.project_id && thread?.deletedAt === null) return id;
      }
      return run.parent_run_id ? yield* originatingThread(run.parent_run_id) : null;
    });

  const sync = (step: StepRow, ask: SignalboxAsk) =>
    Effect.gen(function* () {
      const threadId = yield* originatingThread(step.run_id);
      if (threadId && threads.syncAsk) {
        const shell = yield* threads.getThreadShell(ThreadId.make(threadId));
        // Deleted threads cannot accept commands; the workflow journal remains the history.
        if (shell && shell.deletedAt === null) yield* threads.syncAsk(ThreadId.make(threadId), ask);
      }
      yield* store.markAskSynced(step.run_id, step.step_key, encodeAsk(ask), yield* nowIso);
    });

  const open = (automation: AutomationRow, step: StepRow) =>
    Effect.gen(function* () {
      const current = (yield* store.getStep(step.run_id, step.step_key)) ?? step;
      if (!current.ask_json)
        yield* store.insertStepAsk(
          step.run_id,
          step.step_key,
          encodeAsk(automationAskRecord(automation, current)),
        );
      const latest = (yield* store.getStep(step.run_id, step.step_key)) ?? current;
      const ask = automationAskRecord(automation, latest);
      yield* sync(latest, ask);
      return ask;
    });

  /** Called inside the step settlement transaction; delivery happens after it commits. */
  const settled = (
    step: StepRow,
    now: string,
    context?: AutomationAnswerContext,
    value?: unknown,
  ) =>
    Effect.gen(function* () {
      const run = yield* store.getRunMeta(step.run_id);
      const automation = run ? yield* store.getAutomation(run.automation_id) : undefined;
      if (!automation) return undefined;
      const ask = automationAskRecord(automation, step);
      const at = now < ask.updatedAt ? ask.updatedAt : now;
      const command: typeof SignalboxAskAnswerCommand.Type | undefined =
        context?.command ??
        (context
          ? {
              type: "thread.ask.answer",
              commandId: CommandId.make(`${ask.id}:answer`),
              threadId: ThreadId.make(ask.id),
              askId: ask.id,
              round: ask.rounds.at(-1)!.number,
              answers: [{ questionId: step.step_key, value: askJsonValue(value) }],
              deferredQuestionIds: [],
              answeredBy: context.answeredBy ?? { kind: "person", personId: "local-user" },
              ...(context.comment === undefined ? {} : { comment: context.comment }),
            }
          : undefined);
      const applied = applyAskCommand(
        [ask],
        command ?? {
          type: "thread.ask.withdraw",
          commandId: CommandId.make(`${ask.id}:withdraw`),
          threadId: ThreadId.make(ask.id),
          askId: ask.id,
        },
        at,
      );
      if (!applied.ok) return yield* fail(applied.error, { runId: step.run_id });
      const updated = applied.asks[0]!;
      yield* store.setStepAsk(step.run_id, step.step_key, encodeAsk(updated));
      return updated;
    });

  const answer = (command: typeof SignalboxAskAnswerCommand.Type, supplied: SignalboxAsk) =>
    Effect.gen(function* () {
      if (supplied.source.kind !== "automation")
        return yield* fail("This isn't an automation ask.");
      const { runId, stepKey } = supplied.source;
      const step = yield* store.getStep(runId, stepKey);
      const run = yield* store.getRunMeta(runId);
      const automation = run ? yield* store.getAutomation(run.automation_id) : undefined;
      if (!step || !automation || step.verb !== "ask")
        return yield* fail("That question was already answered.", { runId });
      const ask = automationAskRecord(automation, step);
      if (ask.id !== supplied.id || ask.id !== command.askId)
        return yield* fail("The automation ask doesn't match this step.", { runId });
      const receipts = fromJson(step.ask_receipts_json ?? "[]");
      if (Array.isArray(receipts) && receipts.includes(command.commandId)) {
        yield* sync(step, ask);
        return;
      }
      if (step.status !== "waiting")
        return yield* fail("That question was already answered.", { runId });
      const now = yield* nowIso;
      const applied = applyAskCommand([ask], command, now < ask.updatedAt ? ask.updatedAt : now);
      if (!applied.ok) return yield* fail(applied.error, { runId });
      const answerInput = command.answers[0];
      if (!answerInput) {
        const updated = applied.asks[0]!;
        yield* store.withTransaction(
          Effect.gen(function* () {
            const changed = yield* store.updateWaitingAsk(
              runId,
              stepKey,
              step.ask_json ?? null,
              encodeAsk(updated),
            );
            if (!changed)
              return yield* fail("This ask round has changed. Reload before answering.", {
                runId,
              });
            yield* store.keepAskReceipt(runId, stepKey, command.commandId);
          }),
        );
        yield* sync(step, updated);
        yield* deps.runChanged(runId, true);
        return;
      }
      const resolved = resolveAutomationAskAnswer(
        stepAsk(step).ask,
        automationAskAnswerFromValue(answerInput.value),
      );
      if (!resolved.ok) return yield* fail(resolved.error, { runId });
      // Store the normalized engine result, so defaults and option order stay authoritative.
      const normalized = {
        ...command,
        answers: [{ ...answerInput, value: askJsonValue(resolved.value) }],
      };
      const completed = yield* deps.complete(
        runId,
        stepKey,
        { ok: true, value: resolved.value },
        { command: normalized },
      );
      if (!completed) {
        const latest = yield* store.getStep(runId, stepKey);
        const taken = fromJson(latest?.ask_receipts_json ?? "[]");
        if (!Array.isArray(taken) || !taken.includes(command.commandId))
          return yield* fail("This ask round has changed. Reload before answering.", { runId });
      }
    });

  const recover = Effect.gen(function* () {
    for (const step of yield* store.asksToSync()) {
      const run = yield* store.getRunMeta(step.run_id);
      const automation = run ? yield* store.getAutomation(run.automation_id) : undefined;
      if (!automation) continue;
      yield* open(automation, step).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Automation ask couldn't reach its thread", {
            runId: step.run_id,
            cause,
          }),
        ),
      );
    }
  });
  return { open, settled, sync, recover, answer };
};
