import { onFreshSession, type RunnerTurn } from "@signalbox/runner-protocol/RunnerProtocol";
import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";

import { cut } from "../../context/threadContext.ts";

/**
 * A turn for a harness with no session to resume: the thread switched
 * provider, never learned which session it wrote (#382), or the store never
 * got a row of it because the machine was lost first (#465). The harness
 * starts a new session, and the turn's prompt carries what the thread said so
 * far, so the agent picks up the conversation rather than a bare "Continue
 * where you left off.". The thread shows the prompt as the user sent it.
 *
 * A turn that does resume carries the same prompt (`freshSessionText`), for
 * the Runner to start fresh on should the resume fail on the machine (#653).
 */

type Turn = Omit<RunnerTurn, "traceId">;

/** Characters of earlier conversation a fresh session is given, about 16k tokens. */
const CONTEXT_CHARS = 64_000;
/** Characters of one message kept; the rest of it is cut. */
const MESSAGE_CHARS = 16_000;

/**
 * The conversation before `turn`. Undo keeps the full retained text; other
 * session recovery keeps recent messages and the first request within a budget.
 */
export function transcriptBefore(projection: OrchestrationV2ThreadProjection, turn: Turn): string {
  // The main agent's side of it: each run's root node (or none named), not its subagents'.
  const rootNodes = new Set([null, ...projection.runs.map((run) => run.rootNodeId)]);
  const rolledBack = new Set(
    projection.runs.filter((run) => run.status === "rolled_back").map((run) => run.id),
  );
  // Undo clears the native session; its replacement must retain the entire surviving conversation.
  const afterUndo = rolledBack.size > 0;
  const messages = projection.turnItems
    .flatMap((item) =>
      (item.type === "user_message" || item.type === "assistant_message") &&
      item.text !== "" &&
      item.runId !== turn.runId &&
      (item.runId === null || !rolledBack.has(item.runId)) &&
      rootNodes.has(item.nodeId)
        ? [
            {
              ordinal: item.ordinal,
              role: item.type,
              text: afterUndo ? item.text : cut(item.text, MESSAGE_CHARS).text,
            },
          ]
        : [],
    )
    .sort((left, right) => left.ordinal - right.ordinal);
  const kept = new Set<number>();
  let remaining = afterUndo ? Infinity : CONTEXT_CHARS;
  const keep = (index: number) => {
    const message = messages[index];
    if (message === undefined || message.text.length > remaining) return false;
    kept.add(index);
    remaining -= message.text.length;
    return true;
  };
  keep(messages.findIndex((message) => message.role === "user_message"));
  for (let index = messages.length - 1; index >= 0; index--) {
    if (!kept.has(index) && !keep(index)) break;
  }
  if (kept.size === 0) return "";
  const lines = [
    "This conversation started before your current session, so here is what was said so far. It is context, not a new request.",
  ];
  messages.forEach((message, index) => {
    if (!kept.has(index)) {
      // One note where the left-out run of messages begins.
      if (kept.has(index - 1)) lines.push("(Some messages are left out here.)");
      return;
    }
    lines.push(`${message.role === "user_message" ? "User" : "Assistant"}:\n${message.text}`);
  });
  return lines.join("\n\n");
}

/** `turn`'s message on a new harness session, with the conversation so far before it. */
export function freshSessionText(projection: OrchestrationV2ThreadProjection, turn: Turn): string {
  const transcript = transcriptBefore(projection, turn);
  return transcript === ""
    ? turn.message.text
    : `${transcript}\n\nUser message:\n${turn.message.text}`;
}

/** `turn` on a new harness session, with the conversation so far in its prompt. */
export function freshSessionTurn(projection: OrchestrationV2ThreadProjection, turn: Turn): Turn {
  return onFreshSession(turn, freshSessionText(projection, turn));
}
