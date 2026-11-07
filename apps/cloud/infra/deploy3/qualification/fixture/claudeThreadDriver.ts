import { isTerminalRunStatus, latestRun } from "@signalbox/automations/runs";
import type { RunnerTurn } from "@signalbox/runner-protocol/RunnerProtocol";
import {
  CommandId,
  defaultInstanceIdForDriver,
  MessageId,
  type OrchestrationV2RunStatus,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import { SCRATCH_PROJECT_ID } from "../../../../src/environment.ts";
import { createWorkerdLocalClaudeThreadHost } from "../../../../src/LocalClaudeThreadHostWorkerd.ts";
import { readRpcData, rpcStubOwner } from "../../../../src/rpc/Resources.ts";
import { CLAUDE_QUALIFICATION_PROMPTS, ClaudeQualificationModelPeer } from "./claudeModelPeer.ts";
import { CLAUDE_THREAD_VARIANT, claudeThreadTemplate } from "./claudeThread.ts";
import { errorRecord } from "./common.ts";
import { proof, type QualifierEnvironment } from "./environment.ts";

type ThreadEnvironment = Pick<
  QualifierEnvironment,
  "QUALIFIER" | "RUN_ID" | "CLAUDE_USERS" | "CLAUDE_POOLS" | "CLAUDE_THREADS"
>;

/**
 * Runs each prompt as one turn through the product's public user, pool and thread objects, the
 * way a client would. A turn starts only after the previous one completed.
 */
export const runClaudeThreadTurns = (input: {
  readonly env: ThreadEnvironment;
  readonly template: RunnerTurn;
  readonly modelTransport: (request: Request) => Promise<Response>;
  readonly prompts: readonly string[];
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = input.template.threadId;
      // A client selects the harness's own instance; the product resolves it onto a pool.
      const modelSelection = {
        ...input.template.modelSelection,
        instanceId: defaultInstanceIdForDriver(input.template.providerThread.driver),
      };
      const binding = yield* createWorkerdLocalClaudeThreadHost({
        modelSelection,
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
            // The owner's personal scratch project, which every local domain can see.
            projectId: SCRATCH_PROJECT_ID,
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

/**
 * The qualifier's Claude step: the work prompt, then the resume prompt only if work completed,
 * against its scripted model peer. The peer's evidence is kept whether or not a turn failed.
 */
export async function runQualifierClaudeThread(env: ThreadEnvironment) {
  const cap = proof(env);
  using _cap = rpcStubOwner(cap);
  const inputs = await readRpcData(cap.claudeThreadInputs(CLAUDE_THREAD_VARIANT));
  const peer = new ClaudeQualificationModelPeer(inputs.runtime.workload);
  const prompts = [CLAUDE_QUALIFICATION_PROMPTS.work, CLAUDE_QUALIFICATION_PROMPTS.resume];
  const exit = await Effect.runPromiseExit(
    runClaudeThreadTurns({
      env,
      template: claudeThreadTemplate(inputs),
      modelTransport: (request) => peer.fetch(request),
      prompts,
    }),
  );
  if (!Exit.isSuccess(exit))
    return {
      completed: false,
      turns: [],
      model: peer.snapshot(),
      // Every reason, so a defect beside a failure is never lost.
      failure: {
        pretty: Cause.pretty(exit.cause),
        reasons: exit.cause.reasons.map((reason) =>
          errorRecord(
            Cause.isFailReason(reason)
              ? reason.error
              : Cause.isDieReason(reason)
                ? reason.defect
                : reason,
          ),
        ),
      },
    };
  const turns = exit.value;
  return {
    completed:
      turns.length === prompts.length && turns.every((turn) => turn.status === "completed"),
    turns,
    model: peer.snapshot(),
  };
}
