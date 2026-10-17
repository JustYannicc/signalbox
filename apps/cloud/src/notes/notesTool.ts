import type { ToolResult } from "@signalbox/runner-protocol/AutomationProtocol";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { UserNotes } from "./UserNotes.ts";

/**
 * `LIST_NOTES_TOOL`, which a thread's agent calls from its machine
 * (`apps/server/src/signalbox/runner/RunnerAutomationTools.ts`): the team
 * notes on its home's chain, as the folders' agents may read them. It
 * arrives on the automation tools' route, since that already names the thread.
 */
export const listNotesTool = (threadId: string) =>
  Effect.gen(function* (): Effect.fn.Return<ToolResult> {
    const notes = yield* Effect.serviceOption(UserNotes);
    if (Option.isNone(notes)) return { _tag: "failed", message: "Notes aren't in this cloud." };
    return yield* notes.value.listForAgent({ threadId: ThreadId.make(threadId) }).pipe(
      Effect.map((listed): ToolResult => ({ _tag: "ok", result: { notes: listed } })),
      Effect.catchTags({
        SqlError: (cause) =>
          Effect.logError("listing notes for an agent failed", { cause }).pipe(
            Effect.as<ToolResult>({ _tag: "failed", message: "Notes are unavailable right now." }),
          ),
      }),
    );
  });
