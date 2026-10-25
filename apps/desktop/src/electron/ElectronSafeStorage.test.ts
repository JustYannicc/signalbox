import { assert, describe, it } from "@effect/vitest";
import { beforeEach, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ElectronSafeStorage from "./ElectronSafeStorage.ts";

const { safeStorage } = vi.hoisted(() => ({
  safeStorage: {
    isEncryptionAvailable: vi.fn(),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
    isAsyncEncryptionAvailable: vi.fn(),
    encryptStringAsync: vi.fn(),
    decryptStringAsync: vi.fn(),
    getSelectedStorageBackend: vi.fn(),
  },
}));

vi.mock("electron", () => ({ safeStorage }));

const makeStorage = (platform: NodeJS.Platform = "darwin") =>
  ElectronSafeStorage.make.pipe(Effect.provideService(HostProcess.Platform, platform));

describe("ElectronSafeStorage", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    for (const method of [
      safeStorage.isEncryptionAvailable,
      safeStorage.encryptString,
      safeStorage.decryptString,
    ]) {
      method.mockImplementation(() => {
        throw new Error("Synchronous Keychain access would block the main thread");
      });
    }
  });

  it.effect("keeps macOS credential access asynchronous while Keychain access is pending", () =>
    Effect.gen(function* () {
      const storage = yield* makeStorage();
      let finishAvailability: ((available: boolean) => void) | undefined;
      safeStorage.isAsyncEncryptionAvailable.mockImplementation(
        () =>
          new Promise<boolean>((resolve) => {
            finishAvailability = resolve;
          }),
      );

      const availability = yield* Effect.forkChild(storage.isEncryptionAvailable);
      // A queued main-thread task must run before the native credential request completes.
      yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
      if (!finishAvailability) throw new Error("Async credential request did not start");
      finishAvailability(true);
      assert.isTrue(yield* Fiber.join(availability));

      const ciphertext = Buffer.from("v10-disposable-ciphertext");
      safeStorage.encryptStringAsync.mockResolvedValue(ciphertext);
      safeStorage.decryptStringAsync.mockResolvedValue({
        result: "credential",
        shouldReEncrypt: false,
      });
      assert.deepEqual(yield* storage.encryptString("credential"), ciphertext);
      assert.equal(yield* storage.decryptString(new Uint8Array(ciphertext)), "credential");
      assert.deepEqual(safeStorage.decryptStringAsync.mock.calls, [[ciphertext]]);
      assert.equal(safeStorage.isEncryptionAvailable.mock.calls.length, 0);
      assert.equal(safeStorage.encryptString.mock.calls.length, 0);
      assert.equal(safeStorage.decryptString.mock.calls.length, 0);
    }),
  );

  it.effect("preserves typed failures when native async access is rejected", () =>
    Effect.gen(function* () {
      const storage = yield* makeStorage();
      const cause = new Error("Keychain access denied");
      safeStorage.isAsyncEncryptionAvailable.mockRejectedValue(cause);
      safeStorage.encryptStringAsync.mockRejectedValue(cause);
      safeStorage.decryptStringAsync.mockRejectedValue(cause);

      const availability = yield* Effect.flip(storage.isEncryptionAvailable);
      const encryption = yield* Effect.flip(storage.encryptString("credential"));
      const decryption = yield* Effect.flip(storage.decryptString(new Uint8Array()));
      assert.instanceOf(availability, ElectronSafeStorage.ElectronSafeStorageAvailabilityError);
      assert.instanceOf(encryption, ElectronSafeStorage.ElectronSafeStorageEncryptError);
      assert.instanceOf(decryption, ElectronSafeStorage.ElectronSafeStorageDecryptError);
      for (const failure of [availability, encryption, decryption])
        assert.strictEqual(failure.cause, cause);
    }),
  );

  it.effect.each(["win32", "linux"] as const)(
    "preserves the existing %s encryption backend",
    (platform) =>
      Effect.gen(function* () {
        const storage = yield* makeStorage(platform);
        const ciphertext = Buffer.from("existing-ciphertext");
        safeStorage.isEncryptionAvailable.mockReturnValue(true);
        safeStorage.encryptString.mockReturnValue(ciphertext);
        safeStorage.decryptString.mockReturnValue("credential");
        assert.isTrue(yield* storage.isEncryptionAvailable);
        assert.deepEqual(yield* storage.encryptString("credential"), ciphertext);
        assert.equal(yield* storage.decryptString(ciphertext), "credential");
        assert.equal(safeStorage.isAsyncEncryptionAvailable.mock.calls.length, 0);
        assert.equal(safeStorage.encryptStringAsync.mock.calls.length, 0);
        assert.equal(safeStorage.decryptStringAsync.mock.calls.length, 0);
      }),
  );
});
