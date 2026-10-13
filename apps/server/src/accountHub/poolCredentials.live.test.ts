/**
 * Everything in a pool, against the real pinned CLIProxyAPI: an API key beside
 * a login, a native Codex login moved in, Cursor keys handed out in turn, and
 * API keys that outlive a hub restart. Opt in with SIGNALBOX_ACCOUNT_HUB_LIVE=1;
 * it downloads the hub release (about 20 MB).
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { PERSONAL_POOL_ID } from "@t3tools/contracts/accountHub";
import * as NetService from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Settings from "../serverSettings.ts";
import * as AccountHub from "./AccountHub.ts";
import * as AccountPools from "./AccountPools.ts";
import { listApiKeys } from "./hubApiKeys.ts";
import { makeCursorPool, saveCursorAccount } from "./hubCursor.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const jwt = (claims: Record<string, unknown>) =>
  [
    Buffer.from(encodeJson({ alg: "none" })).toString("base64url"),
    Buffer.from(encodeJson(claims)).toString("base64url"),
    "sig",
  ].join(".");

const poolsLayer = (baseDir: string) =>
  AccountPools.layer.pipe(
    Layer.provideMerge(AccountHub.layer),
    Layer.provideMerge(Settings.ServerSettingsService.layerTest()),
    Layer.provide(ServerSecretStore.layer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
    Layer.provide(NetService.layer),
    Layer.provide(TestProviderHost.layer()),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provide(
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make("live-environment")),
      }),
    ),
  );

const eventually = <A, E, R>(read: Effect.Effect<A, E, R>, until: (value: A) => boolean) =>
  read.pipe(Effect.repeat({ schedule: Schedule.spaced("100 millis"), until, times: 50 }));

describe.skipIf(process.env.SIGNALBOX_ACCOUNT_HUB_LIVE !== "1")("pool credentials (live)", () => {
  it.live(
    "keeps API keys, moved logins, and Cursor accounts in the pool's hub",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "pool-credentials-live-" });
        const codexHome = `${baseDir}/codex-home`;
        yield* fs.makeDirectory(codexHome, { recursive: true });
        yield* fs.writeFileString(
          `${codexHome}/auth.json`,
          encodeJson({
            tokens: {
              id_token: jwt({ email: "native@example.com" }),
              access_token: jwt({ exp: 4_102_444_800 }),
              refresh_token: "rt",
              account_id: "acct",
            },
          }),
        );

        yield* Effect.gen(function* () {
          const pools = yield* AccountPools.AccountPools;
          const hub = yield* AccountHub.AccountHub;
          const settings = yield* Settings.ServerSettingsService;
          const http = yield* HttpClient.HttpClient;

          // A Claude API key sits in the pool and the hub serves Claude models for it.
          yield* pools.addApiKey({
            poolId: PERSONAL_POOL_ID,
            provider: "anthropic",
            apiKey: "sk-ant-api03-live-test",
          });
          const endpoint = Option.getOrThrow(yield* hub.endpoint);
          const keys = yield* listApiKeys(endpoint);
          expect(keys.map((key) => key.label)).toEqual(["Anthropic API key ····test"]);
          const models = yield* eventually(
            http
              .execute(
                HttpClientRequest.get(`${endpoint.baseUrl}/v1/models`).pipe(
                  HttpClientRequest.bearerToken(endpoint.clientKey),
                ),
              )
              .pipe(Effect.flatMap((response) => response.text)),
            (text) => text.includes("claude-"),
          );
          expect(models).toContain("claude-");
          expect(
            (yield* settings.getSettings).providerInstances[ProviderInstanceId.make("claude_hub")],
          ).toMatchObject({
            driver: "claudeAgent",
            config: { setupMode: "hub" },
          });

          // A native Codex login moves in, and its own instance goes off.
          yield* settings.updateSettings({
            providerInstances: {
              ...(yield* settings.getSettings).providerInstances,
              [ProviderInstanceId.make("codex")]: {
                driver: ProviderDriverKind.make("codex"),
                config: { homePath: codexHome },
              },
            },
          });
          const moved = yield* pools.moveNativeLogins({
            poolId: PERSONAL_POOL_ID,
            instanceIds: [ProviderInstanceId.make("codex")],
          });
          expect(moved).toEqual({ moved: ["codex"], failed: [] });
          const accounts = yield* eventually(hub.accounts, (list) => list.length > 0);
          expect(accounts.map((account) => [account.name, account.type])).toEqual([
            ["codex-native@example.com.json", "codex"],
          ]);
          const after = (yield* settings.getSettings).providerInstances;
          expect(after[ProviderInstanceId.make("codex")]?.enabled).toBe(false);
          expect(after[ProviderInstanceId.make("codex_hub")]).toMatchObject({
            driver: "codex",
            config: { setupMode: "hub" },
          });

          // Cursor keys live in the hub and are handed out in turn.
          yield* saveCursorAccount(hub, { apiKey: "key_one", email: "one@example.com" });
          yield* saveCursorAccount(hub, { apiKey: "key_two", email: "two@example.com" });
          yield* eventually(hub.accounts, (list) => list.length === 3);
          const pool = yield* makeCursorPool(hub);
          // Status checks read the current account without moving on; sessions take turns.
          const current = (yield* Effect.promise(() => pool.store.load()))?.apiKey;
          expect((yield* Effect.promise(() => pool.store.load()))?.apiKey).toBe(current);
          const handed = [(yield* pool.next)?.apiKey, (yield* pool.next)?.apiKey].toSorted();
          expect(handed).toEqual(["key_one", "key_two"]);
        }).pipe(Effect.provide(poolsLayer(baseDir)));

        // A new server rewrites the hub's config; the key the hub saved is still there.
        yield* Effect.gen(function* () {
          const hub = yield* AccountHub.AccountHub;
          const endpoint = yield* hub.ensureRunning;
          const keys = yield* listApiKeys(endpoint);
          expect(keys.map((key) => key.label)).toEqual(["Anthropic API key ····test"]);
        }).pipe(Effect.provide(poolsLayer(baseDir)));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    180_000,
  );
});
