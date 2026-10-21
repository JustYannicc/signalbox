import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { vi } from "vite-plus/test";
import { hostFixture } from "./hostFixture.ts";

describe("Harness seed catalog payload ownership", () => {
  it.effect("shares verified asset bytes and seeds after the source changes", () =>
    Effect.gen(function* () {
      const f = yield* hostFixture;
      const copies = yield* Effect.acquireRelease(
        Effect.sync(() => vi.spyOn(Uint8Array, "from")),
        (spy) => Effect.sync(() => spy.mockRestore()),
      );
      const instance = yield* f.make();
      const source = f.artifact.files.get("cli/assets/help")!;
      const index = copies.mock.calls.findIndex(([bytes]) => bytes === source);
      const owned = copies.mock.results[index];
      if (owned?.type !== "return") throw new Error("Missing verified asset copy");
      expect(owned.value).toEqual(source);
      expect(copies.mock.calls.filter(([bytes]) => bytes === owned.value)).toHaveLength(0);

      source.fill(0);
      yield* instance.host.seed("assets");
      yield* instance.host.seed("assets");
    }).pipe(Effect.scoped),
  );

  it.effect.each(["size", "hash"] as const)(
    "rereads programs and rejects a changed %s before claiming seeded files",
    (failure) =>
      Effect.gen(function* () {
        const f = yield* hostFixture;
        const bytes = new TextEncoder().encode("seed executable");
        const hash = yield* Effect.promise(() => crypto.subtle.digest("SHA-256", bytes));
        const sha256 = Array.from(new Uint8Array(hash), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
        let corrupt = false;
        let reads = 0;
        const programs = {
          sourceIdentity: "storage-backed-test",
          files: {
            "/bin/test": { bytes: bytes.length, sha256, mode: 0o755, uid: 1000, gid: 1000 },
          },
          async read() {
            reads++;
            return corrupt
              ? failure === "size"
                ? bytes.subarray(1)
                : new Uint8Array(bytes.length)
              : bytes;
          },
        };
        const instance = yield* f.make({ programs });
        expect(reads).toBe(0);
        yield* instance.host.seed("assets");
        yield* instance.host.seed("programs");
        expect(reads).toBe(1);
        corrupt = true;
        expect(Exit.isFailure(yield* instance.open().pipe(Effect.exit))).toBe(true);
        expect(reads).toBe(2);
        expect(f.handle.rows("SELECT * FROM harness_boot_attempts")).toHaveLength(0);

        yield* instance.host.dispose;
        f.reopen();
        corrupt = false;
        const recovered = yield* f.make({ programs });
        const session = yield* recovered.open();
        expect(reads).toBe(3);
        yield* session.dispose;
      }).pipe(Effect.scoped),
  );
});
