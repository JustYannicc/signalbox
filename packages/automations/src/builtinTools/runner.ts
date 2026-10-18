import type { AutomationError, RuntimeMode } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { explained } from "../runLog.ts";
import { TransientFailure } from "../stepPolicy.ts";
import type { VersionApproval } from "../WorkflowStore.ts";

/**
 * `w.call(label, "signalbox.<tool>", args)`: Signalbox's own MCP tools as
 * steps, run in-process through the same handlers agents reach over MCP.
 * The MCP server builds the handlers, so it registers them here once it's up
 * (see layer.ts); the engine only knows this narrow seam.
 */

const BUILTIN_TOOL_PREFIX = "signalbox.";

/** The `service` the compiler gives built-in tool steps, for their logo. */
const BUILTIN_TOOL_SERVICE = "signalbox";

export const isBuiltinToolOperation = (operation: string) =>
  operation.startsWith(BUILTIN_TOOL_PREFIX);

export interface BuiltinToolCall {
  /** The MCP tool name, without the `signalbox.` prefix. */
  readonly tool: string;
  readonly args: unknown;
  readonly automationId: string;
  /** The automation's project, and the run calling. */
  readonly projectId: string;
  readonly runId: string;
  readonly automationName: string;
  /** The automation's runtime mode: the most the call may do, as for any MCP client. */
  readonly runtimeMode: RuntimeMode;
  /** Stable per step, so tools with a clientRequestId don't repeat after a restart or retry. */
  readonly requestKey: string;
}

export interface BuiltinToolHandler {
  readonly tools: ReadonlyArray<string>;
  readonly call: (input: BuiltinToolCall) => Effect.Effect<unknown, AutomationError>;
}

/**
 * Tools only code a person or Signalbox stands behind may call, and only on
 * threads of the automation's own project. Agents can save and run their own
 * automations, so without this an agent could merge by writing a two-line
 * automation instead of asking the merge gate.
 */
const VOUCHED_TOOLS: ReadonlySet<string> = new Set(["pull_request_action"]);

const isTaskLifecycleRead = (args: unknown) =>
  typeof args === "object" &&
  args !== null &&
  (args as { readonly action?: unknown }).action === "read";

export interface BuiltinToolGuards {
  /** Who stands behind the code of the run's version. */
  readonly approvalOf: (runId: string) => Effect.Effect<VersionApproval | null, AutomationError>;
  readonly projectOfThread: (
    threadId: string,
  ) => Effect.Effect<string | undefined, AutomationError>;
}

export const makeBuiltinTools = (guards: BuiltinToolGuards) => {
  let handler: BuiltinToolHandler | null = null;

  const vouched = (tool: string, input: Omit<BuiltinToolCall, "tool">) =>
    Effect.gen(function* () {
      const approval = yield* guards.approvalOf(input.runId);
      if (approval !== "signalbox" && approval !== "person") {
        if (tool === "task_lifecycle")
          return yield* explained(
            "Only Signalbox's own automations, or one a person published, can change a task's lifecycle.",
            {
              why: "Agent-authored automations can read task state, but lifecycle changes need a version a person published.",
              fix: "Save it as a draft and have a person publish the version in Signalbox.",
            },
          );
        return yield* explained(
          `Only Signalbox's own automations, or one a person published, can use signalbox.${tool}.`,
          {
            why: "An agent saved this version, and agents ask for merges through the merge gate rather than make them.",
            fix: "Save it as a draft and have the user publish it in Signalbox, or call merge_pull_request.",
          },
        );
      }
      const threadId = (input.args as { readonly threadId?: unknown } | null)?.threadId;
      const projectId =
        typeof threadId === "string" ? yield* guards.projectOfThread(threadId) : undefined;
      if (projectId !== input.projectId)
        return yield* explained(
          `signalbox.${tool} only acts on threads in the automation's own project.`,
          {
            fix: "Pass the threadId of a thread in this project.",
          },
        );
    });

  const register = (next: BuiltinToolHandler) =>
    Effect.sync(() => {
      handler = next;
    });

  /** Calls `signalbox.<tool>`; fails with the tools there are when it isn't one. */
  const call = (operation: string, input: Omit<BuiltinToolCall, "tool">) =>
    Effect.suspend(() => {
      const tool = operation.slice(BUILTIN_TOOL_PREFIX.length);
      if (handler === null) {
        const message = "Signalbox's tools aren't ready yet.";
        return Effect.fail(
          explained(message, {
            why: "The server is still starting its MCP tools.",
            cause: new TransientFailure(message),
          }),
        );
      }
      if (!handler.tools.includes(tool)) {
        return Effect.fail(
          explained(`"${operation}" isn't one of Signalbox's tools for automations.`, {
            fix: `Use one of: ${handler.tools.map((name) => `${BUILTIN_TOOL_PREFIX}${name}`).join(", ")}.`,
          }),
        );
      }
      const call = handler.call({ ...input, tool });
      const needsVouch =
        VOUCHED_TOOLS.has(tool) || (tool === "task_lifecycle" && !isTaskLifecycleRead(input.args));
      return needsVouch ? vouched(tool, input).pipe(Effect.andThen(call)) : call;
    });

  return { register, call };
};

export type BuiltinTools = ReturnType<typeof makeBuiltinTools>;
