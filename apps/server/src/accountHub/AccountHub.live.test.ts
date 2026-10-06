/**
 * Runs the real pinned CLIProxyAPI release: download, checksum, start, sign-in
 * start, an account file, and account actions through the usage-source client.
 * Opt in with SIGNALBOX_ACCOUNT_HUB_LIVE=1; it downloads about 20 MB. Host process
 * references keep their defaults, so this runs the release for this machine.
 */
// @effect-diagnostics nodeBuiltinImport:off - runs a second hub as a stand-in source.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeChildProcess from "node:child_process";
import { describe, expect, it } from "@effect/vitest";
import { ACCOUNT_HUB_SOURCE_ID } from "@t3tools/contracts/accountHub";
import * as NetService from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import { FetchHttpClient } from "effect/unstable/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { makeCliproxyApi } from "../usage/cliproxyApi.ts";
import * as AccountHub from "./AccountHub.ts";

describe.skipIf(process.env.SIGNALBOX_ACCOUNT_HUB_LIVE !== "1")("AccountHub (live)", () => {
  it.live(
    "installs, starts, signs in, and manages accounts with the real hub",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "account-hub-live-" });
        // Set SIGNALBOX_CHATGPT_PLUGIN to a built chatgpt-siwc library to load it as well.
        const plugin = process.env.SIGNALBOX_CHATGPT_PLUGIN;
        if (plugin) {
          const dir = `${baseDir}/userdata/account-hub/plugins`;
          yield* fs.makeDirectory(dir, { recursive: true });
          yield* fs.copyFile(plugin, `${dir}/${plugin.split("/").at(-1)}`);
        }
        const layer = AccountHub.layer.pipe(
          Layer.provide(ServerSecretStore.layer),
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
          Layer.provide(NetService.layer),
          Layer.provideMerge(FetchHttpClient.layer),
        );
        yield* Effect.gen(function* () {
          const hub = yield* AccountHub.AccountHub;
          yield* hub.ensureRunning;

          const login = yield* hub.startOAuthLogin("claude", { localCallback: false });
          expect(login.url).toMatch(/^https:\/\/claude\.ai\/oauth\/authorize\?/);
          expect(new URL(login.url).searchParams.get("redirect_uri")).toBe(
            "http://localhost:54545/callback",
          );
          const wrong = yield* login
            .complete("http://localhost:54545/callback?code=x&state=wrong")
            .pipe(Effect.flip);
          expect(wrong.detail).toContain("does not belong");
          yield* login.cancel;

          yield* hub.saveCredential("chatgpt-siwc-live@example.com.json", {
            type: "chatgpt-siwc",
            client_id: "oaiapp_live",
            access_token: "a",
            refresh_token: "r",
            expires_at: 4_102_444_800,
            email: "live@example.com",
          });
          const accounts = yield* hub.accounts.pipe(
            Effect.repeat({
              schedule: Schedule.spaced("100 millis"),
              until: (list) => list.length > 0,
              times: 50,
            }),
          );
          expect(accounts.map((account) => account.name)).toEqual([
            "chatgpt-siwc-live@example.com.json",
          ]);

          const [id, config] = Option.getOrThrow(yield* hub.usageLimitSource);
          expect(id).toBe(ACCOUNT_HUB_SOURCE_ID);
          const api = yield* makeCliproxyApi;
          expect(yield* api.readAccounts(config)).toMatchObject([
            {
              id: "chatgpt-siwc-live@example.com.json",
              driver: "codex",
              email: "live@example.com",
            },
          ]);
          yield* api.updateAccount(config, "chatgpt-siwc-live@example.com.json", "pause");
          expect(yield* api.readAccounts(config)).toMatchObject([{ disabled: true }]);
          yield* api.updateAccount(config, "chatgpt-siwc-live@example.com.json", "resume");
          expect((yield* api.readAccounts(config))[0]?.disabled).toBeUndefined();
          yield* api.updateAccount(config, "chatgpt-siwc-live@example.com.json", "remove");
          expect(yield* api.readAccounts(config)).toEqual([]);
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    120_000,
  );

  it.live(
    "moves accounts out of another CLIProxyAPI, then switches to it as the hub",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "account-hub-live-" });
        const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "account-hub-source-" });
        const layer = AccountHub.layer.pipe(
          Layer.provide(ServerSecretStore.layer),
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
          Layer.provideMerge(NetService.layer),
          Layer.provideMerge(FetchHttpClient.layer),
        );
        yield* Effect.gen(function* () {
          const hub = yield* AccountHub.AccountHub;
          const managed = yield* hub.ensureRunning;

          // A second CLIProxyAPI, standing in for one the user already runs.
          const net = yield* NetService.NetService;
          const port = yield* net.reserveLoopbackPort();
          yield* fs.makeDirectory(`${sourceDir}/auths`);
          for (const name of ["claude-a@example.com.json", "xai-b@example.com.json"]) {
            yield* fs.writeFileString(
              `${sourceDir}/auths/${name}`,
              `{"type":"${name.split("-")[0]}","email":"${name.slice(name.indexOf("-") + 1, -5)}","access_token":"a","refresh_token":"r"}`,
            );
          }
          yield* fs.writeFileString(
            `${sourceDir}/config.yaml`,
            [
              "config-version: 8",
              `server: { host: "127.0.0.1", port: ${port} }`,
              'management: { allow-remote: false, secret-key: "source-mgmt", disable-control-panel: true }',
              'access: { api-keys: ["source-client"] }',
              `oauth: { auth-dir: "${sourceDir}/auths" }`,
              "",
            ].join("\n"),
          );
          const binary = `${baseDir}/tools/cliproxyapi/8.0.15/cli-proxy-api`;
          const source = NodeChildProcess.spawn(binary, ["--config", `${sourceDir}/config.yaml`], {
            stdio: "ignore",
          });
          yield* Effect.addFinalizer(() => Effect.sync(() => source.kill()));
          const sourceUrl = `http://127.0.0.1:${port}`;
          const sourceFiles = Effect.promise(() =>
            fetch(`${sourceUrl}/v0/management/auth-files`, {
              headers: { authorization: "Bearer source-mgmt" },
            })
              .then((response) => response.json() as Promise<{ files: Array<{ name: string }> }>)
              .then((body) => body.files.map((file) => file.name).toSorted())
              .catch(() => [] as string[]),
          );
          yield* sourceFiles.pipe(
            Effect.repeat({
              schedule: Schedule.spaced("150 millis"),
              until: (names) => names.length === 2,
              times: 60,
            }),
          );

          const result = yield* hub.importAccounts({
            url: sourceUrl,
            managementKey: "source-mgmt",
            removeFromSource: true,
          });
          expect(result.imported.toSorted()).toEqual([
            "claude-a@example.com.json",
            "xai-b@example.com.json",
          ]);
          expect(result.failed).toEqual([]);
          expect(yield* sourceFiles).toEqual([]);
          const inHub = yield* hub.accounts.pipe(
            Effect.repeat({
              schedule: Schedule.spaced("100 millis"),
              until: (list) => list.length === 2,
              times: 50,
            }),
          );
          expect(inHub.map((account) => account.name).toSorted()).toEqual(
            result.imported.toSorted(),
          );
          // Importing the same hub again only skips.
          const again = yield* hub.importAccounts({
            url: sourceUrl,
            managementKey: "source-mgmt",
            removeFromSource: false,
          });
          expect(again).toEqual({ imported: [], skipped: [], failed: [] });

          // Connecting checks both keys before saving anything.
          const badKey = yield* hub
            .setConnection({
              mode: "external",
              url: sourceUrl,
              managementKey: "source-mgmt",
              clientKey: "wrong",
            })
            .pipe(Effect.flip);
          expect(badKey.detail).toContain("API key");
          expect(yield* hub.connection).toEqual({ mode: "managed" });

          expect(
            yield* hub.setConnection({
              mode: "external",
              url: `${sourceUrl}/`,
              managementKey: "source-mgmt",
              clientKey: "source-client",
            }),
          ).toEqual({ mode: "external", url: sourceUrl });
          const external = yield* hub.ensureRunning;
          expect(external.baseUrl).toBe(sourceUrl);
          expect(external.clientKey).toBe("source-client");
          // The managed hub stopped and is not restarted.
          const managedUp = yield* Effect.promise(() =>
            fetch(`${managed.baseUrl}/v1/models`).then(
              () => true,
              () => false,
            ),
          );
          expect(managedUp).toBe(false);
          const [, config] = Option.getOrThrow(yield* hub.usageLimitSource);
          expect(config.url).toBe(sourceUrl);

          expect(yield* hub.setConnection({ mode: "managed" })).toEqual({ mode: "managed" });
          expect((yield* hub.ensureRunning).baseUrl).toBe(managed.baseUrl);
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    120_000,
  );
});
