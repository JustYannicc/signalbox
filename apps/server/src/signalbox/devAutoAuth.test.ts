import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthAccessWriteScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import { expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as AuthHttp from "../auth/http.ts";
import { resolveServerConfig } from "../cli/config.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";

const DEV_TOKEN = "reusable-dev-auth-token-that-is-long-enough";
class AuthTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.auth) {}

const makeRoutes = (devAutoAuth: boolean) => {
  const layerConfig = Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      return {
        ...config,
        mode: "web",
        devUrl: new URL("http://127.0.0.1:5173"),
        devAuthToken: Redacted.make(DEV_TOKEN),
        devAutoAuth,
      } satisfies ServerConfig.ServerConfig["Service"];
    }),
  ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-dev-auto-auth-" })));
  return HttpApiBuilder.layer(AuthTestApi).pipe(
    Layer.provide(AuthHttp.layer),
    Layer.provide(AuthHttp.layerAuthenticatedAuth),
    Layer.provideMerge(
      EnvironmentAuth.layer.pipe(
        Layer.provide(SqlitePersistence.layerMemory),
        Layer.provide(ServerSecretStore.layer),
        Layer.provide(ServerEnvironment.layerIdentity),
        Layer.provide(layerConfig),
      ),
    ),
    Layer.provide(layerConfig),
    Layer.provideMerge(
      HttpPlatform.layer.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(Etag.layerWeak),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );
};

const sessionRequest = (headers?: Readonly<Record<string, string>>) =>
  new Request("http://127.0.0.1/api/auth/session", headers ? { headers } : undefined);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const postJson = (path: string, body: unknown, headers?: Readonly<Record<string, string>>) =>
  new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: encodeJson(body),
  });

it.effect("dev auto-auth hands cookie-less browsers the reusable dev session", () =>
  Effect.gen(function* () {
    const unusedSecretStore = ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.succeedNone,
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.die("Not used by these routes."),
      remove: () => Effect.void,
    });
    const requestContext = Context.make(Crypto.Crypto, yield* Crypto.Crypto).pipe(
      Context.add(ServerSecretStore.ServerSecretStore, unusedSecretStore),
    );
    return yield* Effect.acquireUseRelease(
      Effect.sync(
        () =>
          [
            HttpRouter.toWebHandler(makeRoutes(true), { disableLogger: true }),
            HttpRouter.toWebHandler(makeRoutes(false), { disableLogger: true }),
          ] as const,
      ),
      ([autoAuth, pairingOnly]) =>
        Effect.tryPromise(async () => {
          const session = await autoAuth.handler(sessionRequest(), requestContext);
          expect(session.status).toBe(200);
          expect(await session.json()).toMatchObject({ authenticated: true });
          const cookies = session.headers.getSetCookie();
          const devCookie = cookies.find((cookie) => cookie.startsWith("t3_dev_session_"));
          expect(devCookie).toContain(`=${DEV_TOKEN};`);
          expect(devCookie).toContain("HttpOnly");
          expect(session.headers.get("cache-control")).toBe("no-store");

          const followUp = await autoAuth.handler(
            sessionRequest({ cookie: devCookie?.split(";", 1)[0] ?? "" }),
            requestContext,
          );
          expect(await followUp.json()).toMatchObject({ authenticated: true });
          expect(followUp.headers.getSetCookie()).toHaveLength(0);

          for (const headers of [
            { authorization: "Bearer not-a-real-token" },
            { authorization: "DPoP not-a-real-token" },
            { origin: "http://127.0.0.1:9999", "sec-fetch-site": "same-site" },
          ]) {
            const client = await autoAuth.handler(sessionRequest(headers), requestContext);
            expect(await client.json()).toMatchObject({ authenticated: false });
            expect(client.headers.getSetCookie()).toHaveLength(0);
          }

          const withoutOptIn = await pairingOnly.handler(sessionRequest(), requestContext);
          expect(await withoutOptIn.json()).toMatchObject({ authenticated: false });
          expect(withoutOptIn.headers.getSetCookie()).toHaveLength(0);

          // Revoking the dev session from a paired session sends new browsers back to pairing.
          const pairing = await autoAuth.handler(
            postJson(
              "/api/auth/pairing-token",
              { scopes: [AuthAccessWriteScope] },
              { cookie: devCookie?.split(";", 1)[0] ?? "" },
            ),
            requestContext,
          );
          const { credential } = (await pairing.json()) as { credential: string };
          const paired = await autoAuth.handler(
            postJson("/api/auth/browser-session", { credential }),
            requestContext,
          );
          const pairedCookie = paired.headers.getSetCookie()[0]?.split(";", 1)[0] ?? "";
          const revoked = await autoAuth.handler(
            postJson("/api/auth/clients/revoke-others", {}, { cookie: pairedCookie }),
            requestContext,
          );
          expect(revoked.status).toBe(200);
          const afterRevoke = await autoAuth.handler(sessionRequest(), requestContext);
          expect(afterRevoke.status).toBe(200);
          expect(await afterRevoke.json()).toMatchObject({ authenticated: false });
          expect(afterRevoke.headers.getSetCookie()).toHaveLength(0);
        }),
      ([autoAuth, pairingOnly]) =>
        Effect.promise(() => Promise.all([autoAuth.dispose(), pairingOnly.dispose()])),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.layer(NodeServices.layer)("dev auto-auth config", (it) => {
  it.effect("resolves only for web dev mode on top of the reusable dev credential", () =>
    Effect.gen(function* () {
      const baseDir = yield* FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) => fs.makeTempDirectoryScoped({ prefix: "t3-dev-auto-auth-cfg-" })),
      );
      const flags = {
        mode: Option.some<"web" | "desktop">("web"),
        port: Option.some(8788),
        host: Option.none<string>(),
        baseDir: Option.some(baseDir),
        cwd: Option.none<string>(),
        devUrl: Option.some(new URL("http://127.0.0.1:5173")),
        noBrowser: Option.none<boolean>(),
        bootstrapFd: Option.none<number>(),
        autoBootstrapProjectFromCwd: Option.none<boolean>(),
        logWebSocketEvents: Option.none<boolean>(),
        tailscaleServeEnabled: Option.none<boolean>(),
        tailscaleServePort: Option.none<number>(),
      };
      const resolve = (env: Record<string, string>, overrides: Partial<typeof flags> = {}) =>
        resolveServerConfig({ ...flags, ...overrides }, Option.none()).pipe(
          Effect.provide(
            Layer.mergeAll(ConfigProvider.layer(ConfigProvider.fromEnv({ env })), NetService.layer),
          ),
          Effect.map((config) => config.devAutoAuth),
        );
      const optedIn = { T3CODE_DEV_AUTH_TOKEN: DEV_TOKEN, T3CODE_DEV_AUTO_AUTH: "true" };

      expect(yield* resolve(optedIn)).toBe(true);
      expect(yield* resolve({ T3CODE_DEV_AUTH_TOKEN: DEV_TOKEN })).toBeUndefined();
      expect(yield* resolve({ T3CODE_DEV_AUTO_AUTH: "true" })).toBeUndefined();
      expect(yield* resolve(optedIn, { mode: Option.some("desktop") })).toBeUndefined();
      expect(yield* resolve(optedIn, { devUrl: Option.none() })).toBeUndefined();
    }),
  );
});
