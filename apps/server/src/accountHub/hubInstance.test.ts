import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { PERSONAL_POOL_ID } from "@t3tools/contracts/accountHub";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Settings from "../serverSettings.ts";
import * as AccountHub from "./AccountHub.ts";
import * as AccountPools from "./AccountPools.ts";
import { withAccountHub } from "./hubInstance.ts";

const EXTERNAL_URL = "https://hub.example.com";

// A CLIProxyAPI the user already runs: it accepts both keys and has no accounts yet.
const externalHub = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        request.url.startsWith(EXTERNAL_URL)
          ? Response.json(request.url.endsWith("/auth-files") ? { files: [] } : { data: [] })
          : new Response(null, { status: 404 }),
      ),
    ),
  ),
);

const poolsLayer = (baseDir: string) =>
  AccountPools.layer.pipe(
    Layer.provideMerge(AccountHub.layer),
    Layer.provideMerge(Settings.ServerSettingsService.layerTest()),
    Layer.provide(ServerSecretStore.layer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
    Layer.provide(NetService.layer),
    Layer.provide(TestProviderHost.layer()),
    Layer.provide(externalHub),
    Layer.provide(Layer.succeed(HostProcess.Platform, "darwin")),
    Layer.provide(Layer.succeed(HostProcess.Architecture, "arm64")),
    Layer.provide(Layer.succeed(HostProcess.Environment, process.env)),
    Layer.provide(
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make("test-environment")),
      }),
    ),
  );

/** The hub address a pool's provider instance would hand its harness. */
const instanceEndpoint = (poolId: string | undefined) =>
  withAccountHub(
    ProviderDriverKind.make("claudeAgent"),
    ProviderInstanceId.make("claude_hub"),
    poolId,
    Effect.flatMap(AccountHub.AccountHub, (hub) => hub.plannedEndpoint),
  );

describe("withAccountHub", () => {
  it.live("runs each pool's instances on that pool's own hub", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "pool-instances-" });
      yield* Effect.gen(function* () {
        const pools = yield* AccountPools.AccountPools;
        const work = yield* pools.create({ name: "Work" });
        yield* pools.setBacking({
          poolId: work.id,
          backing: {
            mode: "external",
            url: EXTERNAL_URL,
            managementKey: "work-management",
            clientKey: "work-client",
          },
        });
        expect((yield* pools.list).map((pool) => [pool.name, pool.backing.mode])).toEqual([
          ["Personal", "managed"],
          ["Work", "external"],
        ]);

        const personal = yield* instanceEndpoint(PERSONAL_POOL_ID);
        const external = yield* instanceEndpoint(work.id);
        expect(external).toMatchObject({ baseUrl: EXTERNAL_URL, clientKey: "work-client" });
        expect(personal.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
        expect(personal.clientKey).not.toBe("work-client");
        // An instance from before pools (no pool id) stays on the personal pool.
        expect(yield* instanceEndpoint(undefined)).toEqual(personal);

        const missing = yield* Effect.flip(instanceEndpoint("gone"));
        expect(missing.detail).toContain("no longer exists");
      }).pipe(Effect.provide(poolsLayer(baseDir)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
