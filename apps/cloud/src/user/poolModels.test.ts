import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthProvidersManageScope,
  EnvironmentId,
  WS_METHODS,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as RpcTest from "effect/rpc/RpcTest";

import type { CloudEnvironmentIdentity } from "../environment.ts";
import { scratchProject } from "../environment.ts";
import { makeMemoryCloud } from "../testing.ts";
import * as CloudRpc from "./rpc.ts";

/**
 * What the model picker gets from a cloud whose pools run the fake
 * CLIProxyAPI (`pool/testing.ts`): its served models, named by the bundled
 * model manifest, and the model new threads start on.
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
  it.effect("offers the models the pool's accounts serve, named by the manifest", () =>
    Effect.gen(function* () {
      const { rpc, personal, signIn } = yield* client();
      // A model CLIProxyAPI serves before the manifest knows it.
      personal.cliProxyApi.catalog.claude!.push({ id: "claude-zephyr-6", created: 1_800_000_000 });
      yield* signIn("claude");

      const { config: current, provider } = yield* config(rpc);
      const claude = provider("claude_hub");
      expect(claude?.status).toBe("ready");
      // The manifest names them and gives them options; legacy and long-gone
      // models stay out; the newcomer shows under its slug.
      expect(claude?.models.map((model) => [model.slug, model.name])).toEqual([
        ["claude-opus-5-5", "Claude Opus 5.5"],
        ["claude-sonnet-5-5", "Claude Sonnet 5.5"],
        ["claude-fable-5-1", "Claude Fable 5.1"],
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
