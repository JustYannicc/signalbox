import {
  CommandId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
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

/** A cloud where `userId`'s Personal pool holds one account of `provider`. */
const cloudWithPool = (provider: "claude" | "codex") =>
  Effect.gen(function* () {
    const cloud = makeMemoryCloud();
    const pool = cloud.pools.directory.forPool(PoolDirectory.poolObjectName(userId, "personal"));
    yield* pool.create({ userId }, { name: "Personal", personal: true });
    const login = yield* pool.startLogin({ userId }, provider);
    if (provider === "codex") {
      cloud.pools
        .objectFor(PoolDirectory.poolObjectName(userId, "personal"))
        .cliProxyApi.authorizeDevice(login.user_code!);
    } else {
      yield* pool.completeLogin(
        { userId },
        `http://localhost/callback?code=c&state=${login.state}`,
      );
    }
    yield* pool.loginStatus({ userId }, login.state);
    const service = yield* CloudThreadService.CloudThreadService.pipe(
      Effect.provide(cloud.layerPersonal(userId)),
    );
    const instanceId = ProviderInstanceId.make(provider === "claude" ? "claude_hub" : "codex_hub");
    const launch = (id: string, model: string, targetInstanceId = instanceId) =>
      service.launchThread(actor, {
        commandId: CommandId.make(`launch-${id}`),
        threadId: ThreadId.make(`thread-${id}`),
        projectId: Environment.SCRATCH_PROJECT_ID,
        title: "Hello",
        modelSelection: { instanceId: targetInstanceId, model },
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
        initialMessage: { messageId: MessageId.make(`message-${id}`), text: "Hi", attachments: [] },
      });
    return { cloud, pool, service, launch };
  });

const cloudWithClaude = cloudWithPool("claude");

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
          models.check({ ownerId: userId, pool: "personal", selection: scriptedModelSelection }),
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

  it.effect("refuses configured harnesses that Cloud cannot run", () =>
    Effect.gen(function* () {
      const cloud = makeMemoryCloud();
      const check = (instanceId: string) =>
        TurnModels.TurnModels.use((models) =>
          models.check({
            ownerId: userId,
            pool: "personal",
            selection: { instanceId: ProviderInstanceId.make(instanceId), model: "model" },
          }),
        ).pipe(
          Effect.provide(
            TurnModels.layer({ scripted: true }).pipe(
              Layer.provide(Layer.succeed(PoolDirectory.PoolDirectory, cloud.pools.directory)),
            ),
          ),
        );

      for (const instanceId of [
        "cursor",
        "grok",
        "opencode",
        "antigravity",
        "muse",
        "pi",
        "custom-provider",
      ]) {
        const refusal = yield* Effect.flip(check(instanceId));
        expect(refusal).toMatchObject({
          _tag: "ProviderUnavailableError",
          instanceId,
          message:
            "That harness isn't available in Signalbox Cloud. Choose Claude or Codex from a pool.",
        });
      }
    }),
  );

  it.effect("accepts supported Claude and Codex modes and rejects unknown modes", () =>
    Effect.gen(function* () {
      for (const provider of ["claude", "codex"] as const) {
        const { cloud } = yield* cloudWithPool(provider);
        const instanceId = ProviderInstanceId.make(
          provider === "claude" ? "claude_hub" : "codex_hub",
        );
        const check = (input: {
          readonly runtimeMode?: RuntimeMode;
          readonly interactionMode?: ProviderInteractionMode;
        }) =>
          TurnModels.TurnModels.use((models) =>
            models.check({
              ownerId: userId,
              pool: "personal",
              selection: {
                instanceId,
                model: provider === "claude" ? "claude-opus-5-5" : "gpt-6.1-sol",
              },
              ...input,
            }),
          ).pipe(
            Effect.provide(
              TurnModels.layer({ scripted: false }).pipe(
                Layer.provide(Layer.succeed(PoolDirectory.PoolDirectory, cloud.pools.directory)),
              ),
            ),
          );

        for (const runtimeMode of [
          "approval-required",
          "auto-accept-edits",
          "auto",
          "full-access",
        ] as const) {
          yield* check({ runtimeMode });
        }
        for (const interactionMode of ["default", "plan"] as const) {
          yield* check({ interactionMode });
        }

        const invalidRuntimeMode = yield* Effect.flip(
          check({ runtimeMode: "future-mode" as unknown as RuntimeMode }),
        );
        expect(invalidRuntimeMode).toMatchObject({
          _tag: "ProviderModeUnavailableError",
          instanceId,
          modeKind: "runtime",
          mode: "future-mode",
        });

        const invalidInteractionMode = yield* Effect.flip(
          check({ interactionMode: "future-mode" as unknown as ProviderInteractionMode }),
        );
        expect(invalidInteractionMode).toMatchObject({
          _tag: "ProviderModeUnavailableError",
          instanceId,
          modeKind: "interaction",
          mode: "future-mode",
        });
      }
    }),
  );

  it.effect("rechecks the live pool catalog after an account is removed", () =>
    Effect.gen(function* () {
      const { pool, launch } = yield* cloudWithClaude;
      expect((yield* launch("before-remove", "claude-opus-5-5")).projection.runs).toHaveLength(1);

      const { accounts } = yield* pool.accounts({ userId });
      yield* pool.updateAccount({ userId }, accounts[0]!.name, "remove");

      const refusal = yield* Effect.flip(launch("after-remove", "claude-opus-5-5"));
      expect(refusal).toMatchObject({
        _tag: "ThreadCommandRejectedError",
        reason: "This pool doesn't serve claude-opus-5-5 right now. Pick another model.",
      });
    }),
  );

  it.effect("does not run a Codex pool model on the Claude harness", () =>
    Effect.gen(function* () {
      const { launch } = yield* cloudWithPool("codex");
      const refusal = yield* Effect.flip(launch("wrong-pool-kind", "gpt-6.1-sol", claude));
      expect(refusal).toMatchObject({
        _tag: "ThreadCommandRejectedError",
        reason: "This pool doesn't serve gpt-6.1-sol right now. Pick another model.",
      });
    }),
  );
});
