// @effect-diagnostics nodeBuiltinImport:off - spawns stand-in leftover processes.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeChildProcess from "node:child_process";
import { describe, expect, it } from "@effect/vitest";
import { ACCOUNT_HUB_SOURCE_ID } from "@t3tools/contracts/accountHub";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as AccountHub from "./AccountHub.ts";
import { ACCOUNT_HUB_VERSION, resolveAccountHubAsset } from "./AccountHubRelease.ts";

// Stands in for CLIProxyAPI: serves the management probe on the configured
// port for the configured key, and exits when asked so restarts can be tested.
const FAKE_HUB = `#!/usr/bin/env node
const fs = require("fs");
const http = require("http");
const config = fs.readFileSync(process.argv[process.argv.indexOf("--config") + 1], "utf8");
const port = Number(/port: (\\d+)/.exec(config)[1]);
const key = JSON.parse(/secret-key: (".*")/.exec(config)[1]);
http
  .createServer((request, response) => {
    if (request.url === "/exit") process.exit(1);
    response.statusCode = request.headers.authorization === "Bearer " + key ? 200 : 401;
    response.end("{}");
  })
  .listen(port, "127.0.0.1");
`;

const harness = Effect.fn("test.accountHubHarness")(function* (
  options: { accounts?: boolean } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "account-hub-" });
  const versionDir = `${baseDir}/tools/cliproxyapi/${ACCOUNT_HUB_VERSION}`;
  yield* fs.makeDirectory(versionDir, { recursive: true });
  yield* fs.writeFileString(`${versionDir}/cli-proxy-api`, FAKE_HUB, { mode: 0o755 });
  yield* fs.writeFileString(
    `${versionDir}/.install-complete.json`,
    `{"version":"${ACCOUNT_HUB_VERSION}","sha256":"${resolveAccountHubAsset("darwin", "arm64")!.sha256}"}`,
  );
  const config = ServerConfig.layerTest(process.cwd(), baseDir);
  if (options.accounts) {
    const hubDir = `${baseDir}/userdata/account-hub/auths`;
    yield* fs.makeDirectory(hubDir, { recursive: true });
    yield* fs.writeFileString(`${hubDir}/claude-a.json`, "{}");
  }
  const layer = AccountHub.layer.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provideMerge(config),
    Layer.provide(NetService.layer),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provide(Layer.succeed(HostProcess.Platform, "darwin")),
    Layer.provide(Layer.succeed(HostProcess.Architecture, "arm64")),
    Layer.provide(Layer.succeed(HostProcess.Environment, process.env)),
  );
  return { baseDir, layer };
});

const running = (hub: AccountHub.AccountHub["Service"], nth: number) =>
  hub.statusChanges.pipe(
    Stream.filter((status) => status.phase === "running"),
    Stream.take(nth),
    Stream.runDrain,
  );

describe("AccountHub", () => {
  it.live("starts on demand on loopback and reports itself as a usage source", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { baseDir, layer } = yield* harness();
      yield* Effect.gen(function* () {
        const hub = yield* AccountHub.AccountHub;
        expect(Option.isNone(yield* hub.endpoint)).toBe(true);

        const endpoint = yield* hub.ensureRunning;
        expect(endpoint.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
        expect(endpoint.managementKey).toMatch(/^[0-9a-f]{64}$/);
        expect(endpoint.clientKey).not.toBe(endpoint.managementKey);
        expect(yield* hub.ensureRunning).toEqual(endpoint);

        const config = yield* fs.readFileString(`${baseDir}/userdata/account-hub/config.yaml`);
        expect(config).toContain('host: "127.0.0.1"');
        expect(config).toContain("allow-remote: false");
        expect(config).toContain(`- "${endpoint.clientKey}"`);

        const status = yield* HttpClient.HttpClient.pipe(
          Effect.flatMap((client) =>
            client.execute(
              HttpClientRequest.get(`${endpoint.baseUrl}/v0/management/config`).pipe(
                HttpClientRequest.bearerToken(endpoint.managementKey),
              ),
            ),
          ),
          Effect.map((response) => response.status),
        );
        expect(status).toBe(200);

        const source = Option.getOrThrow(yield* hub.usageLimitSource);
        expect(source[0]).toBe(ACCOUNT_HUB_SOURCE_ID);
        expect(source[1]).toMatchObject({
          kind: "cliproxy",
          url: endpoint.baseUrl,
          managementKey: endpoint.managementKey,
          enabled: true,
        });
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("restarts the hub after it exits on the same port with the same keys", () =>
    Effect.gen(function* () {
      const { layer } = yield* harness();
      yield* Effect.gen(function* () {
        const hub = yield* AccountHub.AccountHub;
        const first = yield* hub.ensureRunning;
        const restarted = yield* running(hub, 2).pipe(Effect.forkScoped);
        yield* HttpClient.HttpClient.pipe(
          Effect.flatMap((client) =>
            client.execute(HttpClientRequest.get(`${first.baseUrl}/exit`)),
          ),
          Effect.ignore,
        );
        yield* Fiber.join(restarted);
        const second = Option.getOrThrow(yield* hub.endpoint);
        expect(second.baseUrl).toBe(first.baseUrl);
        expect(second.managementKey).toBe(first.managementKey);
        expect(second.clientKey).toBe(first.clientKey);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("stops a hub its previous server left running, and nothing else", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { baseDir, layer } = yield* harness();
      const hubDir = `${baseDir}/userdata/account-hub`;
      yield* fs.makeDirectory(hubDir, { recursive: true });
      // Stand-ins: one carries the hub's config path like a leftover hub, one does not.
      const sleeper = (marker: string) =>
        NodeChildProcess.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", marker], {
          stdio: "ignore",
        });
      const leftover = sleeper(`${hubDir}/config.yaml`);
      const stranger = sleeper("unrelated");
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          leftover.kill();
          stranger.kill();
        }),
      );
      const exited = (child: NodeChildProcess.ChildProcess) =>
        Effect.callback<void>((resume) => {
          if (child.exitCode !== null || child.signalCode !== null) resume(Effect.void);
          else child.once("exit", () => resume(Effect.void));
        });

      yield* fs.writeFileString(`${hubDir}/hub.pid`, `${leftover.pid}\n`);
      yield* Effect.gen(function* () {
        const hub = yield* AccountHub.AccountHub;
        yield* hub.ensureRunning;
        yield* exited(leftover);
        // The new hub recorded itself for the next start.
        const recorded = Number((yield* fs.readFileString(`${hubDir}/hub.pid`)).trim());
        expect(recorded).not.toBe(leftover.pid);
      }).pipe(Effect.provide(layer));

      // A pid recycled by an unrelated process is never touched.
      yield* fs.writeFileString(`${hubDir}/hub.pid`, `${stranger.pid}\n`);
      yield* Effect.gen(function* () {
        const hub = yield* AccountHub.AccountHub;
        yield* hub.ensureRunning;
        expect(stranger.exitCode).toBeNull();
        expect(stranger.signalCode).toBeNull();
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("comes back with the server when accounts exist", () =>
    Effect.gen(function* () {
      const { layer } = yield* harness({ accounts: true });
      yield* Effect.gen(function* () {
        const hub = yield* AccountHub.AccountHub;
        yield* running(hub, 1);
        expect(Option.isSome(yield* hub.endpoint)).toBe(true);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
