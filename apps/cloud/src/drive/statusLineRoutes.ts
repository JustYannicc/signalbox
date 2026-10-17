import {
  STATUS_LINE_PATHS,
  type StatusNoteView,
  statusLineJson,
} from "@signalbox/runner-protocol/StatusLineProtocol";
import {
  STATUS_NEXT_STEP_MAX_LENGTH,
  STATUS_WHERE_IT_GOT_TO_MAX_LENGTH,
} from "@t3tools/contracts/signalboxStatusLine";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { UserDirectory } from "../user/UserDirectory.ts";
import { decodeBody, json, text } from "./routeResponses.ts";

/**
 * The status line API (`StatusLineProtocol.ts`) under the drive API's prefix
 * (#670). The drive route has already checked the thread's drive token: the
 * thread it names is the only one a call reads or writes, its own object
 * holds its line, and its owner's object rolls up its home folder.
 */

const PATHS: ReadonlySet<string> = new Set(Object.values(STATUS_LINE_PATHS));

export const isStatusLineApiPath = (pathname: string) => PATHS.has(pathname);

/** The thread object's side, which the drive route reaches through its stub. */
export interface StatusLineThread {
  readonly statusLine: () => Promise<string | null>;
  readonly writeStatusNote: (input: string) => Promise<StatusNoteView | null>;
}

class ThreadUnavailable extends Schema.TaggedError<ThreadUnavailable>()("ThreadUnavailable", {
  cause: Schema.Defect(),
}) {}

const call = <A>(promise: () => Promise<A>) =>
  Effect.tryPromise({ try: promise, catch: (cause) => new ThreadUnavailable({ cause }) });

const UNREADABLE = `nextStep needs one line of at most ${STATUS_NEXT_STEP_MAX_LENGTH} characters and whereItGotTo one or two sentences of at most ${STATUS_WHERE_IT_GOT_TO_MAX_LENGTH}; neither may be empty.`;

/** One status line call from the thread's machine, for the thread `auth` names. */
export const serveStatusLineRequest = (
  auth: { readonly userId: string; readonly threadId: string },
  thread: StatusLineThread,
  path: string,
  body: string,
) =>
  Effect.gen(function* () {
    switch (path) {
      case STATUS_LINE_PATHS.read: {
        const line = yield* call(() => thread.statusLine());
        return line === null ? text("This thread does not exist.", 404) : json(line);
      }
      case STATUS_LINE_PATHS.write: {
        const input = decodeBody(statusLineJson.writeRequest.decode, body);
        if (input === null) {
          return json(statusLineJson.write.encode({ _tag: "failed", message: UNREADABLE }));
        }
        const note = yield* call(() =>
          thread.writeStatusNote(statusLineJson.writeRequest.encode(input)),
        );
        return json(
          statusLineJson.write.encode(
            note === null
              ? { _tag: "failed", message: "This thread does not exist." }
              : { _tag: "written", note },
          ),
        );
      }
      default: {
        const users = yield* UserDirectory;
        return json(yield* users.forUser(auth.userId).folderStatus(auth.threadId));
      }
    }
  }).pipe(
    // The thread and the call, never what the line says.
    Effect.withSpan("StatusLineRoutes.call", {
      attributes: { "thread.id": auth.threadId, path },
    }),
    // An object didn't answer; the machine retries.
    Effect.catchTags({
      ThreadUnavailable: (error) =>
        Effect.logWarning("a status line call failed", { cause: error.cause }).pipe(
          Effect.as(text("The thread is unavailable right now.", 503)),
        ),
      UserObjectError: (error) =>
        Effect.logWarning("a folder status call failed", { cause: error.cause }).pipe(
          Effect.as(text("The thread's owner is unavailable right now.", 503)),
        ),
    }),
  );
