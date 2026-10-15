import type { AutomationError, RuntimeMode } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { explained } from "../runLog.ts";
import { TransientFailure } from "../stepPolicy.ts";

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

export const makeBuiltinTools = () => {
  let handler: BuiltinToolHandler | null = null;

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
      return handler.call({ ...input, tool });
    });

  return { register, call };
};

export type BuiltinTools = ReturnType<typeof makeBuiltinTools>;
