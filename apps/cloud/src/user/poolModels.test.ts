import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthProvidersManageScope,
  EnvironmentId,
  CommandId,
  ThreadId,
  ORCHESTRATION_V2_WS_METHODS,
  WS_METHODS,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as RpcTest from "effect/rpc/RpcTest";
import { vi } from "vite-plus/test";

import type { CloudEnvironmentIdentity } from "../environment.ts";
import { scratchProject } from "../environment.ts";
import { makeMemoryCloud } from "../testing.ts";
import * as PoolEngine from "../pool/PoolEngine.ts";
import * as CloudRpc from "./rpc.ts";

/**
 * What the model picker gets from a cloud whose pools run the fake
 * CLIProxyAPI (`pool/testing.ts`), including models the fallback labels do not know.
 */

const userId = "user_1";
const actor = { userId };
const production: CloudEnvironmentIdentity = {
  environmentId: EnvironmentId.make("cloud-test"),
  label: "Cloud",
};

const client = (identity = production) =>
  Effect.gen(function* () {
    const cloud = makeMemoryCloud();
    yield* cloud.userDirectory.forUser(userId).recordSignIn({ id: userId, email: "a@b.c" });
    const rpc = yield* RpcTest.makeClient(CloudRpc.CloudRpcGroup).pipe(
      Effect.provide(
        Layer.mergeAll(
          CloudRpc.layerHandlers({ identity, userId, sid: "test-session" }),
          CloudRpc.layerScopeAuthorization([
            AuthOrchestrationReadScope,
            AuthOrchestrationOperateScope,
            AuthProvidersManageScope,
          ]),
        ).pipe(Layer.provide(cloud.layerFor(userId))),
      ),
    );
    // Personal exists from the first look at the pools.
    yield* rpc[WS_METHODS.accountPoolSubscribe]({}).pipe(Stream.take(1), Stream.runDrain);
    const personal = cloud.pools.objectFor(`${userId}:personal`);
    /** Signs an account of `provider` into Personal, as Add account does. */
    const signIn = (provider: "claude" | "codex") =>
      Effect.gen(function* () {
        const pool = cloud.pools.directory.forPool(`${userId}:personal`);
        const login = yield* pool.startLogin(actor, provider);
        yield* pool.completeLogin(actor, `http://localhost/callback?code=c&state=${login.state}`);
        yield* pool.loginStatus(actor, login.state);
        yield* rpc[WS_METHODS.serverRefreshProviders]({});
      });
    return { rpc, personal, signIn };
  });

const config = (rpc: Effect.Success<ReturnType<typeof client>>["rpc"]) =>
  Effect.map(rpc[WS_METHODS.serverGetConfig]({}), (config) => ({
    config,
    provider: (instanceId: string) =>
      config.providers.find((provider) => provider.instanceId === instanceId),
  }));

describe("cloud pool models", () => {
  it.effect("gives a thread the same pool model IDs as server.config and the picker", () =>
    Effect.gen(function* () {
      const { rpc, personal, signIn } = yield* client();
      personal.cliProxyApi.catalog.claude!.push({
        id: "claude-custom-team-model",
        created: 1_800_000_000,
        displayName: "Custom team model",
        reasoningEfforts: [],
      });
      yield* signIn("claude");
      yield* signIn("codex");
      const current = (yield* config(rpc)).config;
      const threadId = ThreadId.make("catalog-agent");
      yield* rpc[ORCHESTRATION_V2_WS_METHODS.launchThread]({
        commandId: CommandId.make("catalog-agent-launch"),
        threadId,
        projectId: scratchProject.id,
        title: "Catalog test",
        modelSelection: current.settings.defaultModelSelection!,
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
      });
      const available = yield* rpc["signalbox.collaboration.capabilities"]({
        sourceThreadId: threadId,
        input: {},
      });
      expect(
        available.providers.map((provider) => ({
          id: provider.providerInstanceId,
          models: provider.models.map((model) => model.id),
        })),
      ).toEqual(
        current.providers.map((provider) => ({
          id: provider.instanceId,
          models: provider.models.map((model) => model.slug),
        })),
      );
      expect(
        available.providers.flatMap((provider) => provider.models.map((model) => model.id)),
      ).toContain("claude-custom-team-model");
      const emptyClient = yield* client();
      emptyClient.personal.cliProxyApi.catalog.claude = [];
      yield* emptyClient.signIn("claude");
      yield* emptyClient.rpc[ORCHESTRATION_V2_WS_METHODS.launchThread]({
        commandId: CommandId.make("catalog-agent-launch"),
        threadId,
        projectId: scratchProject.id,
        title: "Empty catalog test",
        modelSelection: current.settings.defaultModelSelection!,
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
      });
      const empty = yield* emptyClient.rpc["signalbox.collaboration.capabilities"]({
        sourceThreadId: threadId,
        input: {},
      });
      expect(
        empty.providers.every(
          (provider) => provider.models.length === 0 && !provider.canRunChildTask,
        ),
      ).toBe(true);
      const refused = yield* emptyClient.rpc["signalbox.collaboration.delegate"]({
        sourceThreadId: threadId,
        input: {
          task: "Cannot inherit an empty catalog",
          mode: "async",
          clientRequestId: "empty-catalog",
        },
      }).pipe(Effect.flip);
      expect(refused._tag).toBe("OrchestratorMcpFailure");
      if (refused._tag !== "OrchestratorMcpFailure") return;
      expect(refused.code).toBe("provider_unavailable");
      expect(refused.message).toContain("no models");
    }).pipe(Effect.scoped),
  );

  it.effect("reads a scheduled catalog refresh when a client reloads its config", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const startedAt = Date.parse("2026-10-17T10:00:00.000Z");
    vi.setSystemTime(startedAt);
    return Effect.gen(function* () {
      const { rpc, personal, signIn } = yield* client();
      yield* signIn("claude");
      personal.cliProxyApi.catalog.claude!.push({
        id: "claude-new-pool-model",
        created: 1,
        displayName: "New pool model",
        reasoningEfforts: [],
      });
      vi.setSystemTime(startedAt + PoolEngine.MODELS_REFRESH_MS + 1);
      yield* TestClock.adjust(PoolEngine.MODELS_REFRESH_MS + 1);
      yield* Effect.promise(() =>
        personal.runtime.runPromise(
          PoolEngine.PoolEngine.use((engine) => engine.refreshModelsAtAlarm()),
        ),
      );

      const current = yield* config(rpc);
      expect(current.provider("claude_hub")?.models.map((model) => model.slug)).toContain(
        "claude-new-pool-model",
      );
    }).pipe(Effect.scoped, Effect.ensuring(Effect.sync(() => vi.useRealTimers())));
  });

  it.effect("offers every model the pool serves and never invents a model from the fallback", () =>
    Effect.gen(function* () {
      const { rpc, personal, signIn } = yield* client();
      // A model CLIProxyAPI serves before the manifest knows it.
      personal.cliProxyApi.catalog.claude!.push({
        id: "claude-zephyr-6",
        created: 1_800_000_000,
        displayName: "claude-zephyr-6",
        reasoningEfforts: [],
      });
      yield* signIn("claude");

      const { config: current, provider } = yield* config(rpc);
      const claude = provider("claude_hub");
      expect(claude?.status).toBe("ready");
      expect(claude?.models.map((model) => [model.slug, model.name])).toEqual([
        ["claude-opus-5-5", "Claude Opus 5.5"],
        ["claude-sonnet-5-5", "Claude Sonnet 5.5"],
        ["claude-fable-5-1", "Claude Fable 5.1"],
        ["claude-3-7-sonnet-20250219", "Claude 3.7 Sonnet"],
        ["claude-opus-5", "Claude Opus 5"],
        ["claude-zephyr-6", "claude-zephyr-6"],
      ]);
      expect(claude?.models[0]?.capabilities?.optionDescriptors?.length).toBeGreaterThan(0);
      expect(claude?.models.at(-1)?.capabilities).toBeNull();
      // New threads start on the manifest's default, in Personal.
      expect(current.settings.defaultModelSelection).toEqual({
        instanceId: "claude_hub",
        model: "claude-fable-5-1",
      });
      // No ChatGPT account: Codex offers nothing and says to add one.
      expect(provider("codex_hub")).toMatchObject({
        status: "error",
        auth: { status: "unauthenticated" },
        models: [],
      });

      yield* signIn("codex");
      const codex = (yield* config(rpc)).provider("codex_hub");
      expect(codex?.models.map((model) => model.slug)).toEqual([
        "gpt-6.1-sol",
        "gpt-6-astra",
        "gpt-6-luna",
        "gpt-5.5",
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("says to add an account when no pool can run anything, never Scripted", () =>
    Effect.gen(function* () {
      const { rpc } = yield* client();
      const { config: current, provider } = yield* config(rpc);
      expect(current.providers.map((entry) => entry.instanceId)).toEqual([
        "claude_hub",
        "codex_hub",
      ]);
      expect(current.settings.providerInstances).not.toHaveProperty("scripted");
      expect(current.settings.defaultModelSelection).toBeNull();
      expect(provider("claude_hub")).toMatchObject({
        status: "error",
        auth: { status: "unauthenticated" },
      });
      // Scratch has no model of its own, so the environment's default applies.
      expect(scratchProject.defaultModelSelection).toBeNull();
    }).pipe(Effect.scoped),
  );

  it.effect("offers Scripted only where the flag turns it on", () =>
    Effect.gen(function* () {
      const { rpc } = yield* client({ ...production, scripted: true });
      const { config: current } = yield* config(rpc);
      expect(current.providers.map((entry) => entry.instanceId)).toContain("scripted");
      expect(current.settings.providerInstances).toHaveProperty("scripted");
      // With nothing in the pools, dev and tests start on it.
      expect(current.settings.defaultModelSelection?.instanceId).toBe("scripted");
    }).pipe(Effect.scoped),
  );
});
