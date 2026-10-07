import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { ACCOUNT_HUB_SOURCE_ID, PERSONAL_POOL_ID } from "@t3tools/contracts/accountHub";
import {
  HostProcessArchitecture,
  HostProcessEnvironment,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
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
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.succeed(HostProcessPlatform, "darwin")),
    Layer.provide(Layer.succeed(HostProcessArchitecture, "arm64")),
    Layer.provide(Layer.succeed(HostProcessEnvironment, process.env)),
    Layer.provide(
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make("test-environment")),
      }),
    ),
  );

describe("AccountPools", () => {
  it.live("keeps today's hub as the personal pool and adds pools beside it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "account-pools-" });
      yield* Effect.gen(function* () {
        const pools = yield* AccountPools.AccountPools;
        const settings = yield* Settings.ServerSettingsService;

        const [personal] = yield* pools.list;
        expect(personal).toMatchObject({
          id: PERSONAL_POOL_ID,
          name: "Personal",
          sourceId: ACCOUNT_HUB_SOURCE_ID,
          backing: { mode: "managed" },
          personal: true,
        });

        const work = yield* pools.create({ name: "  Acme  " });
        expect(work.name).toBe("Acme");
        expect(work.sourceId).toBe(`signalbox-pool-${work.id}`);
        expect((yield* pools.rename({ poolId: work.id, name: "Acme Corp" })).name).toBe(
          "Acme Corp",
        );
        expect((yield* pools.list).map((pool) => pool.name)).toEqual(["Personal", "Acme Corp"]);
        // Each pool has its own hub.
        expect(yield* pools.hub(work.id)).not.toBe(yield* pools.hub(PERSONAL_POOL_ID));

        // A pool's provider instances go with it; other pools' stay.
        yield* settings.updateSettings({
          providerInstances: {
            [ProviderInstanceId.make(`claude_hub_${work.id}`)]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              enabled: true,
              config: { setupMode: "hub", poolId: work.id },
            },
            [ProviderInstanceId.make("claude_hub")]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              enabled: true,
              config: { setupMode: "hub" },
            },
          },
        });
        yield* fs.makeDirectory(`${baseDir}/userdata/account-pools/${work.id}/auths`, {
          recursive: true,
        });
        yield* pools.remove(work.id);
        expect(Object.keys((yield* settings.getSettings).providerInstances)).toEqual([
          "claude_hub",
        ]);
        expect(yield* fs.exists(`${baseDir}/userdata/account-pools/${work.id}`)).toBe(false);
        expect((yield* Effect.flip(pools.remove(PERSONAL_POOL_ID))).detail).toContain(
          "can't be deleted",
        );
      }).pipe(Effect.provide(poolsLayer(baseDir)));

      // Pools and names survive a restart.
      yield* Effect.gen(function* () {
        const pools = yield* AccountPools.AccountPools;
        yield* pools.rename({ poolId: PERSONAL_POOL_ID, name: "Mine" });
        yield* pools.create({ name: "Home server" });
      }).pipe(Effect.provide(poolsLayer(baseDir)));
      const names = yield* Effect.gen(function* () {
        const pools = yield* AccountPools.AccountPools;
        return (yield* pools.list).map((pool) => pool.name);
      }).pipe(Effect.provide(poolsLayer(baseDir)));
      expect(names).toEqual(["Mine", "Home server"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
