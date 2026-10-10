import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { readNativeLogin } from "./nativeLogins.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

// A JWT with the given claims; the reader only decodes, never verifies.
const jwt = (claims: Record<string, unknown>) =>
  [
    Buffer.from(encodeJson({ alg: "none" })).toString("base64url"),
    Buffer.from(encodeJson(claims)).toString("base64url"),
    "sig",
  ].join(".");

const instance = (
  driver: string,
  config: Record<string, unknown>,
  environment: ReadonlyArray<{ name: string; value: string }> = [],
): ProviderInstanceConfig => ({
  driver: ProviderDriverKind.make(driver),
  config,
  environment: environment.map((variable) => ({ ...variable, sensitive: false })),
});

const testLayer = (baseDir: string) =>
  Layer.mergeAll(
    TestProviderHost.layer(),
    ServerSecretStore.layer.pipe(
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
    ),
    FetchHttpClient.layer,
    Layer.succeed(HostProcess.Platform, "linux"),
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("test-environment")),
    }),
  );

describe("readNativeLogin", () => {
  it.live("turns a Claude Code login in its config directory into a hub account", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "native-claude-" });
      yield* fs.writeFileString(
        `${dir}/.credentials.json`,
        encodeJson({
          claudeAiOauth: {
            accessToken: "sk-ant-oat-a",
            refreshToken: "sk-ant-ort-r",
            expiresAt: 4_102_444_800_000,
          },
        }),
      );
      yield* fs.writeFileString(
        `${dir}/.claude.json`,
        encodeJson({
          oauthAccount: { emailAddress: "me@example.com", organizationUuid: "org" },
        }),
      );
      const login = yield* readNativeLogin(
        ProviderInstanceId.make("claudeAgent"),
        instance("claudeAgent", { homePath: dir }, [
          { name: "ANTHROPIC_API_KEY", value: "sk-ant-api-k" },
        ]),
      ).pipe(Effect.provide(testLayer(dir)));
      expect(login.kind).toBe("claude");
      expect(login.credentials).toEqual([
        {
          kind: "file",
          name: "claude-me@example.com.json",
          content: expect.objectContaining({
            type: "claude",
            access_token: "sk-ant-oat-a",
            refresh_token: "sk-ant-ort-r",
            email: "me@example.com",
            organization_uuid: "org",
            expired: "2100-01-01T00:00:00.000Z",
          }),
        },
        { kind: "apiKey", provider: "anthropic", apiKey: "sk-ant-api-k" },
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("turns the Codex CLI's auth.json into a hub account and an OpenAI key", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "native-codex-" });
      yield* fs.writeFileString(
        `${dir}/auth.json`,
        encodeJson({
          OPENAI_API_KEY: "sk-openai",
          tokens: {
            id_token: jwt({ email: "dev@example.com" }),
            access_token: jwt({ exp: 4_102_444_800 }),
            refresh_token: "rt",
            account_id: "acct",
          },
          last_refresh: "2026-10-01T00:00:00Z",
        }),
      );
      const login = yield* readNativeLogin(
        ProviderInstanceId.make("codex"),
        instance("codex", { homePath: dir }),
      ).pipe(Effect.provide(testLayer(dir)));
      expect(login.kind).toBe("codex");
      expect(login.credentials).toEqual([
        {
          kind: "file",
          name: "codex-dev@example.com.json",
          content: expect.objectContaining({
            type: "codex",
            refresh_token: "rt",
            account_id: "acct",
            email: "dev@example.com",
            last_refresh: "2026-10-01T00:00:00Z",
            expired: "2100-01-01T00:00:00.000Z",
          }),
        },
        { kind: "apiKey", provider: "openai", apiKey: "sk-openai" },
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("moves a Cursor key set on the instance, and fails when there is no login", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "native-cursor-" });
      const withKey = yield* readNativeLogin(
        ProviderInstanceId.make("cursor"),
        instance("cursor", {}, [{ name: "CURSOR_API_KEY", value: "key_abc" }]),
      ).pipe(Effect.provide(testLayer(dir)));
      expect(withKey.credentials).toEqual([{ kind: "cursor", apiKey: "key_abc" }]);

      const missing = yield* readNativeLogin(
        ProviderInstanceId.make("cursor"),
        instance("cursor", {}),
      ).pipe(Effect.provide(testLayer(dir)), Effect.flip);
      expect(missing).toMatchObject({ detail: "No Cursor login was found for this provider." });

      const unsupported = yield* readNativeLogin(
        ProviderInstanceId.make("grok"),
        instance("grok", {}),
      ).pipe(Effect.provide(testLayer(dir)), Effect.flip);
      expect(unsupported).toMatchObject({
        detail: "This provider's login can't move into a pool yet.",
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
