import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";

const packagedWindows = {
  dirname: "/install/resources/app.asar/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "win32",
  processArch: "x64",
  appVersion: "0.0.45",
  appPath: "/install/resources/app.asar",
  isPackaged: true,
  resourcesPath: "/install/resources",
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

const environmentLayer = (
  input: DesktopEnvironment.MakeDesktopEnvironmentInput,
  env: Record<string, string | undefined> = {},
) =>
  DesktopEnvironment.layer(input).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, NodePath.layerPosix, DesktopConfig.layerTest(env)),
    ),
  );

const makeEnvironment = (input: DesktopEnvironment.MakeDesktopEnvironmentInput) =>
  DesktopEnvironment.DesktopEnvironment.pipe(Effect.provide(environmentLayer(input)));

/** Settings on a temporary state dir, with a settings file that turned the local environment on. */
const withSettings = <A, E>(
  input: Omit<DesktopEnvironment.MakeDesktopEnvironmentInput, "homeDirectory">,
  effect: Effect.Effect<A, E, DesktopAppSettings.DesktopAppSettings>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-thin-client-test-" });
    const layer = DesktopAppSettings.layer.pipe(
      Layer.provideMerge(
        environmentLayer({ ...input, homeDirectory: baseDir }, { T3CODE_HOME: baseDir }),
      ),
      Layer.provideMerge(NodeServices.layer),
    );
    return yield* Effect.gen(function* () {
      const environment = yield* DesktopEnvironment.DesktopEnvironment;
      yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
      yield* fileSystem.writeFileString(
        environment.desktopSettingsPath,
        `${JSON.stringify({ localEnvironmentEnabled: true })}\n`,
      );
      return yield* effect;
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("thin cloud desktop build", () => {
  it.effect("serves the client from app.asar when there is no server sidecar", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment({
        ...packagedWindows,
        probeLocalServer: () => false,
      });

      assert.isFalse(environment.localServerBundled);
      assert.isFalse(environment.defaultDesktopSettings.localEnvironmentEnabled);
      assert.equal(
        environment.clientAssetsDir,
        "/install/resources/app.asar/apps/server/dist/client",
      );
    }),
  );

  it.effect("probes the server entry only in packaged builds", () =>
    Effect.gen(function* () {
      const probed: string[] = [];
      const probeLocalServer = (entry: string) => {
        probed.push(entry);
        return false;
      };
      const development = yield* makeEnvironment({
        ...packagedWindows,
        isPackaged: false,
        probeLocalServer,
      });
      assert.isTrue(development.localServerBundled);
      assert.deepEqual(probed, []);

      const packaged = yield* makeEnvironment({ ...packagedWindows, probeLocalServer });
      assert.isFalse(packaged.localServerBundled);
      assert.deepEqual(probed, ["/install/resources/server.asar/apps/server/dist/bin.mjs"]);
    }),
  );

  it.effect("keeps the local environment off even when settings turned it on", () =>
    withSettings(
      { ...packagedWindows, platform: "darwin", probeLocalServer: () => false },
      Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        assert.isFalse((yield* settings.load).localEnvironmentEnabled);
        // Turning it on would relaunch into a server that isn't there.
        assert.isFalse((yield* settings.setLocalEnvironmentEnabled(true)).changed);
        assert.isFalse((yield* settings.get).localEnvironmentEnabled);
      }),
    ),
  );

  it.effect("leaves a build with the local server as it was", () =>
    withSettings(
      { ...packagedWindows, platform: "darwin", probeLocalServer: () => true },
      Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        assert.isTrue((yield* settings.load).localEnvironmentEnabled);
        assert.isTrue((yield* settings.setLocalEnvironmentEnabled(false)).changed);
      }),
    ),
  );
});
