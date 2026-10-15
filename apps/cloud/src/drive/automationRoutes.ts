import { AUTOMATION_PATHS, automationJson } from "@signalbox/runner-protocol/AutomationProtocol";
import * as Effect from "effect/Effect";

import { UserDirectory } from "../user/UserDirectory.ts";
import { decodeBody, json, text } from "./routeResponses.ts";

/**
 * The automation tools API (`AutomationProtocol.ts`) under the drive API's
 * prefix. The drive route has already checked the thread's drive token: the
 * thread it names is the only one a call acts for, and the thread's owner's
 * object runs the call on their automation engine.
 */

export const isAutomationApiPath = (pathname: string) => pathname === AUTOMATION_PATHS.tool;

/** One automation tool call from the thread's machine, for the thread `auth` names. */
export const serveAutomationRequest = (
  auth: {
    readonly userId: string;
    readonly threadId: string;
    /** Whether a turn runs: only a running turn's agent calls tools. */
    readonly live: boolean;
  },
  body: string,
) =>
  Effect.gen(function* () {
    if (!auth.live) return text("Only a running turn uses automation tools.", 403);
    const request = decodeBody(automationJson.toolRequest.decode, body);
    if (request === null) return text("Unreadable request.", 400);
    yield* Effect.annotateCurrentSpan({ "tool.name": request.name });
    const users = yield* UserDirectory;
    const result = yield* users
      .forUser(auth.userId)
      .automationTool(auth.threadId, request.name, request.input);
    return json(automationJson.tool.encode(result));
  }).pipe(
    // The thread and the tool, never what it was asked or answered.
    Effect.withSpan("AutomationRoutes.tool", { attributes: { "thread.id": auth.threadId } }),
    // The owner's object didn't answer; the machine retries.
    Effect.catchTags({
      UserObjectError: (error) =>
        Effect.logWarning("an automation tool call failed", { cause: error.cause }).pipe(
          Effect.as(text("The thread's owner is unavailable right now.", 503)),
        ),
    }),
  );
