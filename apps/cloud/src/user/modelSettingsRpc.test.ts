import {
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  EnvironmentId,
  WS_METHODS,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as RpcTest from "effect/rpc/RpcTest";
import * as SqlClient from "effect/sql/SqlClient";

import { makeMemoryCloud } from "../testing.ts";
import { SCRIPTED_INSTANCE_ID, scriptedModelSelection } from "../thread/scriptedProvider.ts";
import * as CloudRpc from "./rpc.ts";

const userId = "model-settings-user";
const scopes = [AuthOrchestrationReadScope, AuthSettingsWriteScope];
const model = "scripted-echo";

const connectTo = (cloud: ReturnType<typeof makeMemoryCloud>, sid: string, scripted: boolean) =>
  RpcTest.makeClient(CloudRpc.CloudRpcGroup).pipe(
    Effect.provide(
      Layer.mergeAll(
        CloudRpc.layerHandlers({
          identity: {
            environmentId: EnvironmentId.make("cloud-test"),
            label: "Cloud",
            scripted,
          },
          userId,
          sid,
          via: "client",
        }),
        CloudRpc.layerScopeAuthorization(scopes),
      ).pipe(Layer.provide(cloud.layerFor(userId))),
    ),
  );

type Rpc = Effect.Success<ReturnType<typeof connectTo>>;

const waitForSettingsUpdate = (rpc: Rpc) =>
  Effect.gen(function* () {
    const ready = yield* Deferred.make<void>();
    const update = rpc[WS_METHODS.subscribeServerConfig]({}).pipe(
      Stream.tap((event) =>
        event.type === "snapshot" ? Deferred.succeed(ready, undefined) : Effect.void,
      ),
      Stream.filter((event) => event.type === "settingsUpdated"),
      Stream.take(1),
      Stream.runCollect,
      Effect.forkChild,
    );
    const fiber = yield* update;
    yield* Deferred.await(ready);
    return fiber;
  });

describe("cloud model settings RPC", () => {
  it.effect("persists model preferences and streams them to other clients", () =>
    Effect.gen(function* () {
      const cloud = makeMemoryCloud();
      yield* cloud.userDirectory.forUser(userId).recordSignIn({
        id: userId,
        email: "model-settings@example.test",
      });
      const writer = yield* connectTo(cloud, "writer", true);
      const reader = yield* connectTo(cloud, "reader", true);
      const changes = yield* waitForSettingsUpdate(reader);

      const saved = yield* writer[WS_METHODS.serverUpdateSettings]({
        patch: {
          migrateModelPreferences: {
            favorites: [{ provider: SCRIPTED_INSTANCE_ID, model: "old-local-model" }],
            providerModelPreferences: {
              [SCRIPTED_INSTANCE_ID]: { hiddenModels: ["old-local-model"], modelOrder: [] },
            },
          },
          setModelFavorites: [{ provider: SCRIPTED_INSTANCE_ID, model, favorite: true }],
          setModelsHidden: [{ provider: SCRIPTED_INSTANCE_ID, model, hidden: true }],
          setProviderModelOrder: { provider: SCRIPTED_INSTANCE_ID, modelOrder: [model] },
          defaultModelSelection: scriptedModelSelection,
          reviewGuidesEnabled: true,
          reviewGuideModelSelection: scriptedModelSelection,
          reviewGuideInstructions: "Check the changed behavior and report concrete evidence.",
        },
      });
      expect(saved.favorites).toEqual([{ provider: SCRIPTED_INSTANCE_ID, model }]);
      expect(saved.providerModelPreferences?.[SCRIPTED_INSTANCE_ID]).toEqual({
        hiddenModels: [model],
        modelOrder: [model],
      });
      expect(saved.defaultModelSelection).toEqual(scriptedModelSelection);
      expect(saved.reviewGuidesEnabled).toBe(true);
      expect(saved.reviewGuideModelSelection).toEqual(scriptedModelSelection);
      expect(saved.reviewGuideInstructions).toBe(
        "Check the changed behavior and report concrete evidence.",
      );
      const activeConfig = yield* writer[WS_METHODS.serverGetConfig]({});
      expect(activeConfig.environment.capabilities).toMatchObject({
        modelSettingsWrite: true,
        serverSettingsWrite: false,
      });

      const [event] = yield* Fiber.join(changes);
      expect(event?.type).toBe("settingsUpdated");
      if (event?.type !== "settingsUpdated") return;
      expect(event.payload.settings.favorites).toEqual(saved.favorites);
      expect(event.payload.settings.providerModelPreferences).toEqual(
        saved.providerModelPreferences,
      );
      expect(event.payload.settings.defaultModelSelection).toEqual(scriptedModelSelection);
      expect(event.payload.settings.reviewGuidesEnabled).toBe(true);
      expect(event.payload.settings.reviewGuideModelSelection).toEqual(scriptedModelSelection);
      expect(event.payload.settings.reviewGuideInstructions).toBe(
        "Check the changed behavior and report concrete evidence.",
      );

      // Catalog preferences disappear temporarily, but explicit model choices
      // stay selected instead of silently switching work to another model.
      const withoutCatalog = yield* connectTo(cloud, "without-catalog", false);
      const empty = yield* withoutCatalog[WS_METHODS.serverGetConfig]({});
      expect(empty.settings.favorites).toEqual([]);
      expect(empty.settings.providerModelPreferences).toEqual({});
      expect(empty.settings.defaultModelSelection).toEqual(scriptedModelSelection);
      expect(empty.settings.reviewGuidesEnabled).toBe(true);
      expect(empty.settings.reviewGuideModelSelection).toEqual(scriptedModelSelection);
      expect(empty.settings.reviewGuideInstructions).toBe(
        "Check the changed behavior and report concrete evidence.",
      );

      const restored = yield* writer[WS_METHODS.serverGetConfig]({});
      expect(restored.settings.favorites).toEqual(saved.favorites);
      expect(restored.settings.providerModelPreferences).toEqual(saved.providerModelPreferences);
      expect(restored.settings.defaultModelSelection).toEqual(scriptedModelSelection);
      expect(restored.settings.reviewGuidesEnabled).toBe(true);
      expect(restored.settings.reviewGuideModelSelection).toEqual(scriptedModelSelection);
      expect(restored.settings.reviewGuideInstructions).toBe(
        "Check the changed behavior and report concrete evidence.",
      );

      const disabled = yield* writer[WS_METHODS.serverUpdateSettings]({
        patch: { reviewGuidesEnabled: false },
      });
      expect(disabled.reviewGuidesEnabled).toBe(false);
      expect(disabled.reviewGuideModelSelection).toEqual(scriptedModelSelection);
      expect(disabled.reviewGuideInstructions).toBe(
        "Check the changed behavior and report concrete evidence.",
      );
      expect((yield* writer[WS_METHODS.serverGetConfig]({})).settings.reviewGuidesEnabled).toBe(
        false,
      );
    }).pipe(Effect.scoped),
  );

  it.effect("reads saved model settings written before review guide fields existed", () =>
    Effect.gen(function* () {
      const cloud = makeMemoryCloud();
      yield* cloud.userDirectory.forUser(userId).recordSignIn({
        id: userId,
        email: "model-settings@example.test",
      });
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const legacyValue = JSON.stringify({
          favorites: null,
          providerModelPreferences: null,
          defaultModelSelection: null,
        });
        yield* sql`INSERT INTO user_model_settings (id, value) VALUES (1, ${legacyValue})`;
      }).pipe(Effect.provide(cloud.userObject(userId)));

      const rpc = yield* connectTo(cloud, "legacy-row", true);
      const { settings } = yield* rpc[WS_METHODS.serverGetConfig]({});
      expect(settings.reviewGuidesEnabled).toBe(false);
      expect(settings.reviewGuideModelSelection).toBeNull();
      expect(settings.reviewGuideInstructions).toBe("");
    }).pipe(Effect.scoped),
  );

  it.effect("rejects unrelated settings and model IDs outside the live catalog", () =>
    Effect.gen(function* () {
      const cloud = makeMemoryCloud();
      yield* cloud.userDirectory.forUser(userId).recordSignIn({
        id: userId,
        email: "model-settings@example.test",
      });
      const rpc = yield* connectTo(cloud, "writer", true);

      const unrelated = yield* rpc[WS_METHODS.serverUpdateSettings]({
        patch: { defaultRuntimeMode: "full-access" },
      }).pipe(Effect.flip);
      expect(unrelated._tag).toBe("ServerSettingsError");

      const unavailableModel = yield* rpc[WS_METHODS.serverUpdateSettings]({
        patch: {
          setModelFavorites: [
            { provider: SCRIPTED_INSTANCE_ID, model: "retired-model", favorite: true },
          ],
        },
      }).pipe(Effect.flip);
      expect(unavailableModel._tag).toBe("ServerSettingsError");

      const unavailableGuideModel = yield* rpc[WS_METHODS.serverUpdateSettings]({
        patch: {
          reviewGuideModelSelection: {
            instanceId: SCRIPTED_INSTANCE_ID,
            model: "retired-model",
          },
        },
      }).pipe(Effect.flip);
      expect(unavailableGuideModel._tag).toBe("ServerSettingsError");
    }).pipe(Effect.scoped),
  );
});
