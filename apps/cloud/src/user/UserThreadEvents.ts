import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as CloudAutomations from "../automations/CloudAutomations.ts";
import type { StoredEvent } from "../thread/ThreadStore.ts";
import * as UserLearner from "./UserLearner.ts";

type Observe = UserLearner.UserLearner["Service"]["observe"];
type AutomationEvents = CloudAutomations.CloudAutomationsShape["threadEvents"];

export class UserThreadEvents extends Context.Service<
  UserThreadEvents,
  {
    readonly publish: (input: {
      readonly threadId: string;
      readonly events: ReadonlyArray<StoredEvent>;
    }) => Effect.Effect<
      void,
      Effect.Error<ReturnType<Observe>> | Effect.Error<ReturnType<AutomationEvents>>
    >;
  }
>()("@signalbox/cloud/user/UserThreadEvents") {}

const make = Effect.gen(function* () {
  const learner = yield* UserLearner.UserLearner;
  return UserThreadEvents.of({
    publish: ({ threadId, events }) =>
      Effect.gen(function* () {
        yield* learner.observe(ThreadId.make(threadId), events);
        const automations = yield* Effect.serviceOption(CloudAutomations.CloudAutomations);
        if (Option.isSome(automations)) {
          yield* automations.value.threadEvents({ threadId, events });
        }
      }).pipe(
        Effect.withSpan("UserThreadEvents.publish", { attributes: { "thread.id": threadId } }),
      ),
  });
});

export const layer = Layer.effect(UserThreadEvents, make);
