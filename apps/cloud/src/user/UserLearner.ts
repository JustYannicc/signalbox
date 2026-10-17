import { ThreadId } from "@t3tools/contracts";
import type { SignalboxLearnerEvent } from "@t3tools/contracts/signalboxLearner";
import type { FolderId } from "@t3tools/contracts/signalboxFolders";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { SqlError } from "effect/sql/SqlError";

import * as LearnerService from "../learner/LearnerService.ts";
import * as LearnerSummary from "../learner/LearnerSummary.ts";
import * as LearnerHomes from "./LearnerHomes.ts";

type Core = LearnerService.LearnerService["Service"];
type Failure =
  | Effect.Error<ReturnType<Core["logEvent"]>>
  | LearnerHomes.LearnerAccessError
  | SqlError;

/**
 * The learner inside a user's object. This is the seam asks (#667) calls:
 * record the recommendation as a draft and the answer as a human_action,
 * with the same objectId (ask/question id) and distinct stable eventIds.
 * Answers given on behalf of someone carry usedLensId on the draft so the
 * later human action scores it. No caller can choose a store or a person.
 */
export class UserLearner extends Context.Service<
  UserLearner,
  {
    readonly log: (
      threadId: ThreadId,
      event: Omit<SignalboxLearnerEvent, "treeId">,
    ) => Effect.Effect<Effect.Success<ReturnType<Core["logEvent"]>>, Failure>;
    readonly statement: (
      threadId: ThreadId,
      statement: { readonly text: string; readonly reason: string },
    ) => Effect.Effect<Effect.Success<ReturnType<Core["addStatement"]>>, Failure>;
    readonly query: (
      threadId: ThreadId,
      task: string,
    ) => Effect.Effect<Effect.Success<ReturnType<Core["query"]>>, Failure>;
    readonly lenses: (
      threadId: ThreadId,
      input: { readonly folderId?: FolderId | undefined; readonly task?: string | undefined },
    ) => Effect.Effect<Effect.Success<ReturnType<Core["lenses"]>>, Failure>;
  }
>()("@signalbox/cloud/user/UserLearner") {}

const make = Effect.gen(function* () {
  const homes = yield* LearnerHomes.LearnerHomes;
  const learner = yield* LearnerService.LearnerService;
  const summaries = yield* LearnerSummary.LearnerSummary;
  const log: UserLearner["Service"]["log"] = (threadId, event) =>
    Effect.gen(function* () {
      const home = yield* homes.home(threadId);
      return yield* learner.logEvent({
        scope: home.scope,
        event: { ...event, treeId: home.treeId },
      });
    });
  return UserLearner.of({
    log,
    statement: (threadId, statement) =>
      Effect.gen(function* () {
        const home = yield* homes.home(threadId);
        return yield* learner.addStatement({
          scope: home.scope,
          treeId: home.treeId,
          ...statement,
        });
      }),
    query: (threadId, task) =>
      Effect.gen(function* () {
        const home = yield* homes.home(threadId);
        const result = yield* learner.query({ scope: home.scope, task });
        if ((yield* homes.home(threadId)).scope !== home.scope) {
          return yield* new LearnerHomes.LearnerAccessError({ reason: "not-below" });
        }
        return result;
      }),
    lenses: (threadId, input) =>
      Effect.gen(function* () {
        const home = yield* input.folderId === undefined
          ? homes.home(threadId)
          : homes.lower(threadId, input.folderId);
        const result = yield* learner.lenses({ scope: home.scope, task: input.task });
        const visible =
          input.folderId === undefined
            ? result
            : {
                lenses: yield* summaries.summarize({ pool: home.pool, lenses: result.lenses }),
              };
        const current = yield* input.folderId === undefined
          ? homes.home(threadId)
          : homes.lower(threadId, input.folderId);
        if (current.scope !== home.scope)
          return yield* new LearnerHomes.LearnerAccessError({ reason: "not-below" });
        return visible;
      }),
  });
});

export const layer = Layer.effect(UserLearner, make);
