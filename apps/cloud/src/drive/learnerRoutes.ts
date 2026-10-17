import {
  LEARNER_PATHS,
  LearnerAddStatementInput,
  LearnerLensesInput,
  LearnerLogEventInput,
  LearnerQueryInput,
  learnerJson,
} from "@signalbox/runner-protocol/LearnerProtocol";
import * as Effect from "effect/Effect";

import { UserDirectory } from "../user/UserDirectory.ts";
import { decodeBody, json, text } from "./routeResponses.ts";

/** The drive token names the thread; the learner service resolves its level and scope. */
export const isLearnerApiPath = (pathname: string) => pathname === LEARNER_PATHS.tool;

const inputFields = {
  learner_log_event: new Set(Object.keys(LearnerLogEventInput.fields)),
  learner_query: new Set(Object.keys(LearnerQueryInput.fields)),
  learner_add_statement: new Set(Object.keys(LearnerAddStatementInput.fields)),
  learner_lenses: new Set(Object.keys(LearnerLensesInput.fields)),
};

const hasOnlyInputFields = (name: keyof typeof inputFields, value: unknown) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).every((field) => inputFields[name].has(field));

const refused = (message: string) => json(learnerJson.tool.encode({ _tag: "failed", message }));

export const serveLearnerRequest = (
  auth: {
    readonly userId: string;
    readonly threadId: string;
    readonly live: boolean;
  },
  body: string,
) =>
  Effect.gen(function* () {
    if (!auth.live) return text("Only a running turn uses learner tools.", 403);
    const request = decodeBody(learnerJson.toolRequest.decode, body);
    if (request === null) return text("Unreadable request.", 400);
    yield* Effect.annotateCurrentSpan({ "tool.name": request.name });
    if (!hasOnlyInputFields(request.name, request.input)) {
      return refused("Unreadable learner request.");
    }
    const users = yield* UserDirectory;
    const result = yield* users
      .forUser(auth.userId)
      .learnerTool(auth.threadId, request.name, request.input);
    return json(learnerJson.tool.encode(result));
  }).pipe(
    Effect.withSpan("LearnerRoutes.tool", { attributes: { "thread.id": auth.threadId } }),
    Effect.catchTags({
      UserObjectError: (error) =>
        Effect.logWarning("a learner tool call failed", { cause: error.cause }).pipe(
          Effect.as(text("The thread's owner is unavailable right now.", 503)),
        ),
    }),
  );
