import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import * as DesktopPreReadyFileSystem from "./DesktopPreReadyFileSystem.ts";
import { resolveEarlyMacKeychainName } from "./DesktopEarlyElectronStartup.ts";
import { resolveUserDataPath } from "./DesktopUserData.ts";

it.effect("identifies a failed source read and preserves its cause", () => {
  const sourceState = "/profiles/signalbox/Local State";
  const cause = PlatformError.systemError({
    _tag: "PermissionDenied",
    module: "FileSystem",
    method: "readFileString",
    pathOrDescriptor: sourceState,
  });
  return Effect.gen(function* () {
    const error = yield* resolveUserDataPath({
      appDataDirectory: "/profiles",
      isDevelopment: false,
      isPackaged: true,
      platform: "win32",
      dirname: "/app/dist-electron",
    }).pipe(Effect.flip);
    assert.equal(error.operation, "read");
    assert.equal(error.resourcePath, sourceState);
    assert.equal(error.category, "PermissionDenied");
    assert.strictEqual(error.cause, cause);
  }).pipe(
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({
        exists: (path) => Effect.succeed(path === sourceState),
        readFileString: () => Effect.fail(cause),
      }),
    ),
    Effect.provide(NodeServices.layer),
  );
});

it.effect.each(["signalbox", "Signalbox (Alpha)"])(
  "preserves Windows credential keys from %s without copying browser databases",
  (sourceName) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-v2-profile-" });
      const source = path.join(directory, sourceName);
      const destination = path.join(directory, "signalbox-v2");
      const state = '{"os_crypt":{"encrypted_key":"test-encrypted-key"}}';
      yield* fs.makeDirectory(path.join(directory, "Signalbox (Alpha)"), { recursive: true });
      yield* fs.makeDirectory(path.join(source, "IndexedDB"), { recursive: true });
      yield* fs.writeFileString(path.join(source, "Local State"), state);
      yield* fs.writeFileString(path.join(source, "IndexedDB", "LOCK"), "V1 owns this database");
      yield* resolveUserDataPath({
        appDataDirectory: directory,
        isDevelopment: false,
        isPackaged: true,
        platform: "win32",
        dirname: "/app/dist-electron",
      });
      assert.equal(yield* fs.readFileString(path.join(destination, "Local State")), state);
      assert.equal(yield* fs.readFileString(path.join(source, "Local State")), state);
      assert.isFalse(yield* fs.exists(path.join(destination, "IndexedDB")));
      yield* fs.writeFileString(path.join(destination, "Local State"), "existing V2 state");
      yield* resolveUserDataPath({
        appDataDirectory: directory,
        isDevelopment: false,
        isPackaged: true,
        platform: "win32",
        dirname: "/app/dist-electron",
      });
      assert.equal(
        yield* fs.readFileString(path.join(destination, "Local State")),
        "existing V2 state",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("isolates unpackaged macOS Chromium profiles with the early Keychain identity", () =>
  Effect.gen(function* () {
    const nodeFileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* nodeFileSystem.makeTempDirectoryScoped({
      prefix: "t3-mac-profile-",
    });
    const sharedProfile = path.join(directory, "signalbox-dev");
    const legacyProfile = path.join(directory, "Signalbox (Dev)");
    const sharedState = path.join(sharedProfile, "Local State");
    const sharedCookies = path.join(sharedProfile, "Cookies");
    const legacyState = path.join(legacyProfile, "Local State");
    const legacyCookies = path.join(legacyProfile, "Cookies");
    const sentinels = new Map([
      [sharedState, "shared Local State sentinel"],
      [sharedCookies, "shared Cookies sentinel"],
      [legacyState, "legacy Local State sentinel"],
      [legacyCookies, "legacy Cookies sentinel"],
    ]);
    for (const [sentinelPath, sentinel] of sentinels) {
      yield* nodeFileSystem.makeDirectory(path.dirname(sentinelPath), { recursive: true });
      yield* nodeFileSystem.writeFileString(sentinelPath, sentinel);
    }

    const existenceChecks: Array<string> = [];
    const reads: Array<string> = [];
    const writes: Array<string> = [];
    const directories: Array<string> = [];
    const preReadyFileSystem = DesktopPreReadyFileSystem.make;
    const trackedFileSystem = FileSystem.makeNoop({
      exists: (filePath) =>
        Effect.sync(() => existenceChecks.push(filePath)).pipe(
          Effect.flatMap(() => preReadyFileSystem.exists(filePath)),
        ),
      readFileString: (filePath) =>
        Effect.sync(() => reads.push(filePath)).pipe(
          Effect.flatMap(() => preReadyFileSystem.readFileString(filePath)),
        ),
      makeDirectory: (filePath, options) =>
        Effect.sync(() => directories.push(filePath)).pipe(
          Effect.flatMap(() => preReadyFileSystem.makeDirectory(filePath, options)),
        ),
      writeFileString: (filePath, data, options) =>
        Effect.sync(() => writes.push(filePath)).pipe(
          Effect.flatMap(() => preReadyFileSystem.writeFileString(filePath, data, options)),
        ),
    });
    const resolveMacProfile = (input: {
      readonly dirname: string;
      readonly isDevelopment: boolean;
    }) =>
      resolveUserDataPath({
        appDataDirectory: directory,
        dirname: input.dirname,
        isDevelopment: input.isDevelopment,
        isPackaged: false,
        platform: "darwin",
      }).pipe(Effect.provideService(FileSystem.FileSystem, trackedFileSystem));
    const expectedPath = (input: { readonly dirname: string; readonly isDevelopment: boolean }) => {
      const name = resolveEarlyMacKeychainName({
        platform: "darwin",
        isPackaged: false,
        runtimeDirectory: input.dirname,
        isDevelopment: input.isDevelopment,
      });
      assert.isNotNull(name);
      return path.join(directory, name);
    };

    const firstRuntime = { dirname: "/work/Signalbox/dist-electron", isDevelopment: true };
    const firstPath = yield* resolveMacProfile(firstRuntime);
    assert.equal(firstPath, expectedPath(firstRuntime));
    assert.equal(yield* preReadyFileSystem.exists(firstPath), true);

    const normalizedRuntime = {
      dirname: "/work/Signalbox/./dist-electron",
      isDevelopment: true,
    };
    const normalizedPath = yield* resolveMacProfile(normalizedRuntime);
    assert.equal(normalizedPath, firstPath);

    const otherRuntime = { dirname: "/work/Other/dist-electron", isDevelopment: true };
    const otherPath = yield* resolveMacProfile(otherRuntime);
    assert.equal(otherPath, expectedPath(otherRuntime));
    assert.notEqual(otherPath, firstPath);

    const otherMode = { dirname: firstRuntime.dirname, isDevelopment: false };
    const otherModePath = yield* resolveMacProfile(otherMode);
    assert.equal(otherModePath, expectedPath(otherMode));
    assert.notEqual(otherModePath, firstPath);

    assert.deepEqual(existenceChecks, []);
    assert.deepEqual(reads, []);
    assert.deepEqual(writes, []);
    assert.deepEqual(directories, [firstPath, firstPath, otherPath, otherModePath]);
    for (const [sentinelPath, sentinel] of sentinels) {
      assert.equal(yield* nodeFileSystem.readFileString(sentinelPath), sentinel);
    }
    for (const fileName of ["Local State", "Cookies"]) {
      assert.isFalse(yield* preReadyFileSystem.exists(path.join(firstPath, fileName)));
      assert.isFalse(yield* preReadyFileSystem.exists(path.join(otherPath, fileName)));
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("keeps packaged macOS on the existing shared Chromium profile path", () =>
  Effect.gen(function* () {
    const nodeFileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* nodeFileSystem.makeTempDirectoryScoped({
      prefix: "t3-packaged-mac-profile-",
    });
    const userDataPath = yield* resolveUserDataPath({
      appDataDirectory: directory,
      dirname: "/app/dist-electron",
      isDevelopment: false,
      isPackaged: true,
      platform: "darwin",
    });

    assert.equal(userDataPath, path.join(directory, "signalbox-v2"));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
