import { LIST_NOTES_TOOL, type ToolResult } from "@signalbox/runner-protocol/AutomationProtocol";
import { PULL_REQUEST_REVIEW_TOOL } from "@signalbox/runner-protocol/PullRequestReviewTools";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { listNotesTool } from "../notes/notesTool.ts";
import { pullRequestReviewTool } from "../github/pullRequestReviewTool.ts";
import { CloudAutomations } from "./CloudAutomations.ts";

/**
 * One automation tool call from a thread's agent, in its owner's object: the
 * engine answers for the thread the drive token named. Its refusal travels as
 * an answer, so the agent reads the engine's own words.
 */
export const automationTool = (threadId: string, name: string, input: unknown) =>
  Effect.gen(function* (): Effect.fn.Return<ToolResult> {
    if (name === LIST_NOTES_TOOL) return yield* listNotesTool(threadId);
    if (name === PULL_REQUEST_REVIEW_TOOL) return yield* pullRequestReviewTool(threadId, input);
    const automations = yield* Effect.serviceOption(CloudAutomations);
    if (Option.isNone(automations)) {
      return { _tag: "failed", message: "Automations aren't running in this cloud yet." };
    }
    return yield* automations.value.tool({ threadId }, name, input).pipe(
      Effect.map((result) => ({ _tag: "ok" as const, result })),
      Effect.catchTags({
        AutomationError: (error) =>
          Effect.succeed({ _tag: "failed" as const, message: error.message }),
      }),
    );
  }).pipe(
    // The thread and the tool, never what it was asked or answered.
    Effect.withSpan("UserObject.automationTool", {
      attributes: { "thread.id": threadId, "tool.name": name },
    }),
  );
