import { isTerminalRunStatus, latestRun } from "@signalbox/automations/runs";
import { CommandId, MessageId, ProjectId, type OrchestrationV2RunStatus } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { createWorkerdLocalClaudeThreadHost } from "../../../../src/LocalClaudeThreadHostWorkerd.ts";
import { claudeThreadTemplate } from "./claudeThread.ts";
import type { QualifierEnvironment } from "./environment.ts";

/**
 * Runs each prompt as one turn through the product's public user, pool and thread objects, the
 * way a client would, on the thread the qualifier's template turn names. A turn starts only after
 * the previous one completed.
 */
export const runClaudeThreadTurns = (input: {
  readonly env: Pick<
    QualifierEnvironment,
    "QUALIFIER" | "RUN_ID" | "CLAUDE_USERS" | "CLAUDE_POOLS" | "CLAUDE_THREADS"
  >;
  readonly modelTransport: (request: Request) => Promise<Response>;
  readonly prompts: readonly string[];
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const template = yield* Effect.promise(() => claudeThreadTemplate(input.env));
      const threadId = template.threadId;
      const binding = yield* createWorkerdLocalClaudeThreadHost({
        modelSelection: template.modelSelection,
        modelTransport: input.modelTransport,
        machine: {
          type: "workerd",
          threadId,
          objects: {
            user: input.env.CLAUDE_USERS,
            pool: input.env.CLAUDE_POOLS,
            thread: input.env.CLAUDE_THREADS,
          },
        },
      });
      const turns: { readonly runId: string; readonly status: OrchestrationV2RunStatus }[] = [];
      for (const [index, text] of input.prompts.entries()) {
        const id = `${threadId}-turn-${index + 1}`;
        if (index === 0)
          yield* binding.launch({
            commandId: CommandId.make(id),
            threadId,
            projectId: ProjectId.make("qualifier"),
            title: "Claude qualification",
            // The scripted model peer answers only qualification prompts.
            generateTitle: false,
            modelSelection: binding.modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            workspaceStrategy: { type: "root" },
            initialMessage: { messageId: MessageId.make(id), text, attachments: [] },
          });
        else
          yield* binding.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(id),
            createdBy: "user",
            creationSource: "web",
            threadId,
            messageId: MessageId.make(id),
            text,
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            deliveryIntent: "auto",
          });
        const terminal = new Set<string>();
        yield* binding.subscribe().pipe(
          Stream.flattenIterable,
          Stream.takeUntil((item) => {
            const runs =
              item.kind === "snapshot"
                ? item.projection.runs
                : item.kind === "event" && item.event.type === "run.updated"
                  ? [item.event.payload]
                  : [];
            for (const run of runs) if (isTerminalRunStatus(run.status)) terminal.add(run.id);
            return terminal.size > index;
          }),
          Stream.runDrain,
          Effect.raceFirst(binding.failure),
        );
        const run = latestRun((yield* binding.snapshot()).projection);
        if (run === undefined) return yield* Effect.die(new Error("The Claude turn has no run"));
        turns.push({ runId: run.id, status: run.status });
        if (run.status !== "completed") break;
      }
      return turns;
    }),
  );
