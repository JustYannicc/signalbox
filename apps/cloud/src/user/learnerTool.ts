import {
  LearnerAddStatementInput,
  LearnerLensesInput,
  LearnerLogEventInput,
  LearnerQueryInput,
  type LearnerToolResult,
} from "@signalbox/runner-protocol/LearnerProtocol";
import { ThreadId } from "@t3tools/contracts";
import { FolderId } from "@t3tools/contracts/signalboxFolders";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as UserLearner from "./UserLearner.ts";

const decodeEvent = Schema.decodeUnknownEffect(LearnerLogEventInput);
const decodeQuery = Schema.decodeUnknownEffect(LearnerQueryInput);
const decodeStatement = Schema.decodeUnknownEffect(LearnerAddStatementInput);
const decodeLenses = Schema.decodeUnknownEffect(LearnerLensesInput);

/** A tool acts for the thread its drive token named, never ids supplied in the tool input. */
export const learnerTool = (threadId: string, name: string, input: unknown) =>
  Effect.gen(function* () {
    const learner = yield* UserLearner.UserLearner;
    const id = ThreadId.make(threadId);
    switch (name) {
      case "learner_log_event":
        return yield* learner.log(id, yield* decodeEvent(input));
      case "learner_query": {
        const request = yield* decodeQuery(input);
        return yield* learner.query(id, request.task);
      }
      case "learner_add_statement":
        return yield* learner.statement(id, yield* decodeStatement(input));
      case "learner_lenses": {
        const request = yield* decodeLenses(input);
        return yield* learner.lenses(id, {
          task: request.task,
          folderId: request.folderId === undefined ? undefined : FolderId.make(request.folderId),
        });
      }
      default:
        return yield* new UnknownLearnerTool();
    }
  }).pipe(
    Effect.map((result): LearnerToolResult => ({ _tag: "ok", result })),
    Effect.catch((error) =>
      Effect.succeed<LearnerToolResult>({
        _tag: "failed",
        message:
          error._tag === "LearnerAccessError"
            ? error.message
            : error._tag === "SchemaError" || error._tag === "UnknownLearnerTool"
              ? "Unreadable learner request."
              : "The learner couldn't answer. Try again.",
      }),
    ),
    Effect.withSpan("UserObject.learnerTool", {
      attributes: { "thread.id": threadId, "tool.name": name },
    }),
  );

class UnknownLearnerTool extends Schema.TaggedError<UnknownLearnerTool>()(
  "UnknownLearnerTool",
  {},
) {}
