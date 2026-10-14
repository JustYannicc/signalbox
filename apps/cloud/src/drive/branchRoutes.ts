import { BRANCH_PATHS, branchJson } from "@signalbox/runner-protocol/BranchProtocol";
import * as Effect from "effect/Effect";

import { UserDirectory } from "../user/UserDirectory.ts";
import { decodeBody, json, text } from "./routeResponses.ts";

/**
 * The branch API (`BranchProtocol.ts`) under the drive API's prefix. The
 * drive route has already checked the thread's drive token: the thread and
 * drive it names are the only ones a call acts on, and the thread's owner's
 * object does the rest with their own GitHub connection.
 */

export const isBranchApiPath = (pathname: string) => pathname === BRANCH_PATHS.publish;

/** One branch request from the thread's machine, for the thread `auth` names. */
export const serveBranchRequest = (
  auth: {
    readonly userId: string;
    readonly threadId: string;
    readonly driveId: string;
    /** Whether a turn runs: only a running turn's agent publishes. */
    readonly live: boolean;
  },
  body: string,
) =>
  Effect.gen(function* () {
    if (!auth.live) return text("Only a running turn publishes its branch.", 403);
    const request = decodeBody(branchJson.publishRequest.decode, body);
    if (request === null) return text("Unreadable request.", 400);
    const users = yield* UserDirectory;
    const result = yield* users
      .forUser(auth.userId)
      .publishBranch({ threadId: auth.threadId, driveId: auth.driveId, request });
    return json(branchJson.publish.encode(result));
  }).pipe(
    // The owner's object didn't answer; publishing again is safe, so the machine retries.
    Effect.catchTags({
      UserObjectError: (error) =>
        Effect.logWarning("publishing a branch failed", { cause: error.cause }).pipe(
          Effect.as(text("The thread's owner is unavailable right now.", 503)),
        ),
    }),
  );
