// @effect-diagnostics nodeBuiltinImport:off - serves a stand-in CLIProxyAPI and cloud.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttp from "node:http";
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { POOL_LINK_PATH } from "@t3tools/contracts/accountHub";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { FetchHttpClient } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Settings from "../serverSettings.ts";
import * as AccountHub from "./AccountHub.ts";
import * as AccountPools from "./AccountPools.ts";

const poolsLayer = (baseDir: string) =>
  AccountPools.layer.pipe(
    Layer.provideMerge(AccountHub.layer),
    Layer.provideMerge(Settings.ServerSettingsService.layerTest()),
    Layer.provide(ServerSecretStore.layer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
    Layer.provide(NetService.layer),
    Layer.provide(TestProviderHost.layer()),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.succeed(HostProcess.Platform, "darwin")),
    Layer.provide(Layer.succeed(HostProcess.Architecture, "arm64")),
    Layer.provide(Layer.succeed(HostProcess.Environment, process.env)),
    Layer.provide(
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make("test-environment")),
      }),
    ),
  );

const TOKEN = "sbpl_test.secret";

/**
 * One server playing both sides: the user's own CLIProxyAPI the pool runs on
 * (management API under `/v0/management`), and Signalbox Cloud's pool link.
 */
const standIn = Effect.acquireRelease(
  Effect.promise(async () => {
    const hub = new Map<string, string>();
    const cloud = new Map<string, string>();
    const state = { refuse: false };
    const server = NodeHttp.createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", "http://stand-in");
      let body = "";
      for await (const chunk of request) body += chunk;
      const json = (status: number, value: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };
      const route = `${request.method} ${url.pathname}`;
      const name = url.searchParams.get("name") ?? "";
      if (url.pathname.startsWith(POOL_LINK_PATH)) {
        if (request.headers.authorization !== `Bearer ${TOKEN}`) {
          return json(401, { error: { message: "This pool link no longer works." } });
        }
        if (route === `GET ${POOL_LINK_PATH}`) {
          return json(200, {
            name: "Work",
            accounts: [...cloud.keys()].map((account) => ({
              name: account,
              type: account.split("-")[0],
              disabled: false,
              signedOut: false,
            })),
          });
        }
        if (route === `POST ${POOL_LINK_PATH}/accounts`) {
          if (state.refuse)
            return json(502, { error: { message: "The pool could not be reached." } });
          const { accounts } = JSON.parse(body) as {
            accounts: Array<{ name: string; content: string }>;
          };
          for (const account of accounts) cloud.set(account.name, account.content);
          return json(200, { imported: accounts.map((account) => account.name), skipped: [] });
        }
        return json(404, {});
      }
      if (route === "GET /v1/models") return json(200, { data: [] });
      switch (route) {
        case "GET /v0/management/config":
          return json(200, {});
        case "GET /v0/management/auth-files":
          return json(200, {
            files: [...hub.entries()].map(([file, content]) => ({
              name: file,
              ...(JSON.parse(content) as object),
            })),
          });
        case "GET /v0/management/auth-files/download":
          response.writeHead(hub.has(name) ? 200 : 404);
          return response.end(hub.get(name) ?? "");
        case "POST /v0/management/auth-files":
          hub.set(name, body);
          return json(200, { status: "ok" });
        case "DELETE /v0/management/auth-files":
          return json(hub.delete(name) ? 200 : 404, {});
        default:
          return json(404, {});
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    return { url: `http://127.0.0.1:${address.port}`, hub, cloud, state, server };
  }),
  ({ server }) => Effect.promise(() => new Promise((resolve) => server.close(resolve))),
);

const account = (type: string, email: string) =>
  [`${type}-${email}.json`, JSON.stringify({ type, email, refresh_token: "rt" })] as const;

describe("AccountPools.moveToCloud", () => {
  it.live("moves a pool's accounts to the cloud and keeps running it from there", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "account-pools-move-" });
      const remote = yield* standIn;
      const workId = yield* Effect.gen(function* () {
        const pools = yield* AccountPools.AccountPools;
        const settings = yield* Settings.ServerSettingsService;
        const work = yield* pools.create({ name: "Work" });
        yield* pools.setBacking({
          poolId: work.id,
          backing: { mode: "external", url: remote.url, managementKey: "m", clientKey: "c" },
        });
        const claudeId = ProviderInstanceId.make(`claude_hub_${work.id}`);
        const grokId = ProviderInstanceId.make(`grok_hub_${work.id}`);
        yield* settings.updateSettings({
          providerInstances: {
            [claudeId]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              enabled: true,
              config: { setupMode: "hub", poolId: work.id },
            },
            [grokId]: {
              driver: ProviderDriverKind.make("grok"),
              enabled: true,
              config: { setupMode: "hub", poolId: work.id },
            },
          },
        });

        // Something the cloud can't hold stops the move before anything moves.
        remote.hub.set(...account("xai", "x@test"));
        const stuck = yield* Effect.flip(
          pools.moveToCloud({ poolId: work.id, cloudUrl: remote.url, token: TOKEN }),
        );
        expect(stuck.detail).toContain("can't hold these yet: x@test");
        remote.hub.clear();

        // So does a cloud that takes none of it.
        remote.hub.set(...account("claude", "a@test"));
        remote.hub.set(...account("codex", "b@test"));
        remote.state.refuse = true;
        const refused = yield* Effect.flip(
          pools.moveToCloud({ poolId: work.id, cloudUrl: remote.url, token: TOKEN }),
        );
        expect(refused.detail).toBe("The pool could not be reached.");
        expect(remote.hub.size).toBe(2);
        expect((yield* (yield* pools.hub(work.id)).connection).mode).toBe("external");

        remote.state.refuse = false;
        const moved = yield* pools.moveToCloud({
          poolId: work.id,
          cloudUrl: `${remote.url}/`,
          token: TOKEN,
        });
        expect(moved).toEqual({ moved: 2, warnings: [] });
        // Moved, not copied.
        expect([...remote.cloud.keys()]).toEqual(["claude-a@test.json", "codex-b@test.json"]);
        expect(remote.hub.size).toBe(0);

        // Same pool and name; its threads' Claude provider now runs through the link.
        const listed = (yield* pools.list).find((pool) => pool.id === work.id);
        expect(listed).toMatchObject({ name: "Work", backing: { mode: "cloud" } });
        const instances = (yield* settings.getSettings).providerInstances;
        expect(instances[claudeId]?.config).toMatchObject({ hubRevision: expect.any(Number) });
        expect(instances[grokId]).toBeUndefined();
        const hub = yield* pools.hub(work.id);
        expect(yield* hub.ensureRunning).toEqual({
          baseUrl: `${remote.url}${POOL_LINK_PATH}`,
          managementKey: "",
          clientKey: TOKEN,
        });
        expect((yield* hub.accounts).map((entry) => entry.type)).toEqual(["claude", "codex"]);
        expect(Option.isNone(yield* hub.usageLimitSource)).toBe(true);
        expect((yield* Effect.flip(hub.removeCredential("claude-a@test.json"))).detail).toBe(
          "This pool is in Signalbox Cloud now. Manage its accounts there.",
        );
        return work.id;
      }).pipe(Effect.provide(poolsLayer(baseDir)));

      // The link outlives a restart.
      const endpoint = yield* Effect.gen(function* () {
        const pools = yield* AccountPools.AccountPools;
        return yield* (yield* pools.hub(workId)).ensureRunning;
      }).pipe(Effect.provide(poolsLayer(baseDir)));
      expect(endpoint.baseUrl).toBe(`${remote.url}${POOL_LINK_PATH}`);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
