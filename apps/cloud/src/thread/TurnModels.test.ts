import { CommandId, MessageId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { PERSONAL_CONTEXT_ID } from "@t3tools/contracts/signalboxContexts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Environment from "../environment.ts";
import * as PoolDirectory from "../pool/PoolDirectory.ts";
import { makeMemoryCloud } from "../testing.ts";
import * as CloudThreadService from "./CloudThreadService.ts";
import { scriptedModelSelection } from "./scriptedProvider.ts";
import * as TurnModels from "./TurnModels.ts";

const userId = "user_1";
const actor = { userId, contextIds: [PERSONAL_CONTEXT_ID] };
const claude = ProviderInstanceId.make("claude_hub");

/** A cloud where `userId`'s Personal pool holds one Claude account. */
const cloudWithClaude = Effect.gen(function* () {
  const cloud = makeMemoryCloud();
  const pool = cloud.pools.directory.forPool(PoolDirectory.poolObjectName(userId, "personal"));
  yield* pool.create({ userId }, { name: "Personal", personal: true });
  const login = yield* pool.startLogin({ userId }, "claude");
  yield* pool.completeLogin({ userId }, `http://localhost/callback?code=c&state=${login.state}`);
  yield* pool.loginStatus({ userId }, login.state);
  const service = yield* CloudThreadService.CloudThreadService.pipe(
    Effect.provide(cloud.layerPersonal(userId)),
  );
  const launch = (id: string, model: string) =>
    service.launchThread(actor, {
      commandId: CommandId.make(`launch-${id}`),
      threadId: ThreadId.make(`thread-${id}`),
      projectId: Environment.SCRATCH_PROJECT_ID,
      title: "Hello",
      modelSelection: { instanceId: claude, model },
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      initialMessage: { messageId: MessageId.make(`message-${id}`), text: "Hi", attachments: [] },
    });
  return { cloud, service, launch };
});

describe("TurnModels", () => {
  it.effect("starts a turn only on a model its pool serves", () =>
    Effect.gen(function* () {
      const { launch, service } = yield* cloudWithClaude;
      expect((yield* launch("served", "claude-opus-5-5")).projection.runs).toHaveLength(1);

      const unknown = yield* Effect.flip(launch("unknown", "claude-made-up"));
      expect(unknown).toMatchObject({
        _tag: "ThreadCommandRejectedError",
        reason: "This pool doesn't serve claude-made-up right now. Pick another model.",
      });
      // Another provider's model doesn't run on the Claude harness either.
      expect((yield* Effect.flip(launch("codex", "gpt-6.1-sol")))._tag).toBe(
        "ThreadCommandRejectedError",
      );

      // A message on a model the thread no longer can use is refused the same way.
      const refused = yield* Effect.flip(
        service.dispatchCommand(actor, {
          type: "message.dispatch",
          commandId: CommandId.make("send-unknown"),
          createdBy: "user",
          creationSource: "web",
          threadId: ThreadId.make("thread-served"),
          messageId: MessageId.make("message-2"),
          text: "Again",
          attachments: [],
          modelSelection: { instanceId: claude, model: "claude-made-up" },
          dispatchMode: { type: "queue_after_active" },
        }),
      );
      expect(refused.message).toBe(
        "This pool doesn't serve claude-made-up right now. Pick another model.",
      );
    }),
  );

  it.effect("refuses the scripted provider where it is off", () =>
    Effect.gen(function* () {
      const check = (scripted: boolean) =>
        TurnModels.TurnModels.use((models) =>
          models.check({ ownerId: userId, selection: scriptedModelSelection }),
        ).pipe(
          Effect.provide(
            TurnModels.layer({ scripted }).pipe(
              Layer.provide(
                Layer.succeed(PoolDirectory.PoolDirectory, makeMemoryCloud().pools.directory),
              ),
            ),
          ),
        );
      yield* check(true);
      expect((yield* Effect.flip(check(false)))._tag).toBe("ProviderUnavailableError");
    }),
  );
});
