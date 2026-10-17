import {
  STATUS_NEXT_STEP_MAX_LENGTH,
  STATUS_WHERE_IT_GOT_TO_MAX_LENGTH,
} from "@t3tools/contracts/signalboxStatusLine";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";

import type { ContextClient } from "./RunnerContextClient.ts";
import { fail, json, register, type ToolError } from "./RunnerContextTools.ts";
import type { DrivesView } from "./RunnerDrivesView.ts";

/**
 * The thread's status line on the context server (#670): what's going on and
 * what has to happen next, readable by someone who has never seen the thread.
 * Code sets its state and what it waits on; the agent writes the next step and
 * where the work got to before every turn ends (or the runtime writes them from
 * the turn). Every call goes to the cloud with the turn's drive token, which
 * names the thread (`StatusLineProtocol.ts`), so an agent only ever writes its
 * own thread's line.
 */

export const RUNNER_STATUS_LINE_TOOLS = [
  "thread_status",
  "set_thread_status",
  "folder_status",
] as const;

/** Runs `use` with the turn's client; the line opens with the thread's first turn. */
const withClient =
  (view: DrivesView) =>
  <A, E>(use: (client: ContextClient) => Effect.Effect<A, E>) =>
    Effect.suspend((): Effect.Effect<A, E | ToolError> => {
      const client = view.client();
      return client === null
        ? fail("The status line opens once the thread's first turn starts.")
        : use(client);
    });

export const layerStatusLineTools = (view: DrivesView) => {
  const call = withClient(view);
  return Layer.effectDiscard(
    Effect.all([
      register({
        name: "thread_status",
        description:
          "Read this thread's status line, as everyone with access sees it: its state (working, waiting on a person or on something else, idle, archived) with a short headline, what it waits on, and the note: the next step and where the work got to, with who wrote it and when.",
        parameters: Tool.EmptyParams,
        handle: () => call((client) => Effect.map(client.threadStatus, json)),
      }),
      register({
        name: "set_thread_status",
        description: `Write this thread's status note before you finish each turn, and whenever the next step changes. People, and other agents, read it to know what's going on without reading the thread. Plain language for someone who has never seen this thread: no jargon, file paths, ids or shorthand from inside it.`,
        parameters: Schema.Struct({
          nextStep: Schema.String.annotate({
            description: `What has to happen next, and who does it, in one line of at most ${STATUS_NEXT_STEP_MAX_LENGTH} characters. "You: review the draft and say if it can go out." or "Agent: run the migration once the backup finishes."`,
          }),
          whereItGotTo: Schema.String.annotate({
            description: `Where the work stands, in one or two plain sentences of at most ${STATUS_WHERE_IT_GOT_TO_MAX_LENGTH} characters: what was done, and what's left.`,
          }),
        }),
        writes: { destructive: false, openWorld: false },
        handle: (input) =>
          call((client) =>
            Effect.flatMap(client.setThreadStatus(input), (answer) =>
              answer._tag === "written"
                ? Effect.succeed(json({ written: true, note: answer.note }))
                : fail(answer.message),
            ),
          ),
      }),
      register({
        name: "folder_status",
        description:
          "What's going on in this thread's folder: how many threads there and below are working, waiting or idle, the ones that matter most (waiting on a person longest), and each live thread with its status line, people's attention first. Use it to answer \"what's going on?\" about a folder or project.",
        parameters: Tool.EmptyParams,
        handle: () => call((client) => Effect.map(client.folderStatus, json)),
      }),
    ]),
  );
};
