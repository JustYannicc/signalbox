// @effect-diagnostics nodeBuiltinImport:off - uses transport fixtures and an in-memory SQL database.
import * as NodeCrypto from "node:crypto";
import { describe, expect, it } from "@effect/vitest";
import { encodeAssetBundle, PROGRAM_BUNDLE_CONTENT_TYPE } from "./assetBundle.ts";
import { createProofExecutableSeedRoute } from "./proofExecutableSeed.ts";
import { createProofFilesystemHost } from "./proofFilesystem.ts";
import { createProofTestStorage } from "./proofTestStorage.ts";

const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

// These bytes cover route transport and SQLite writes, not executable program behavior.
const programFixtures = [
  { path: "/bin/bash", bytes: new TextEncoder().encode("bash transport fixture\n") },
  { path: "/bin/cat", bytes: new TextEncoder().encode("busybox transport fixture\n") },
  { path: "/bin/rg", bytes: new TextEncoder().encode("ripgrep transport fixture\n") },
] as const;
const programFixtureEntries = programFixtures.map(({ path, bytes }) => ({
  path,
  bytes,
  sha256: sha256(bytes),
}));
const programFixtureCatalog = Object.freeze(
  Object.fromEntries(
    programFixtures.map(({ path, bytes }) => [
      path,
      { bytes: bytes.byteLength, sha256: sha256(bytes) },
    ]),
  ),
);
const programBundle = () => encodeAssetBundle(programFixtureEntries);

function programRequest(body: Uint8Array, options: { method?: string; contentType?: string } = {}) {
  const method = options.method ?? "POST";
  const bodyBuffer = new ArrayBuffer(body.byteLength);
  new Uint8Array(bodyBuffer).set(body);
  return new Request("https://proof.invalid/seed-programs", {
    method,
    headers: { "content-type": options.contentType ?? PROGRAM_BUNDLE_CONTENT_TYPE },
    ...(method === "GET" ? {} : { body: bodyBuffer }),
  });
}

function closeHost(host: ReturnType<typeof createProofFilesystemHost>) {
  host.filesystem.dispose();
  host.persistence.dispose();
  host.wakes.dispose();
}

function expectStoredProgramFixtures(host: ReturnType<typeof createProofFilesystemHost>) {
  for (const entry of programFixtures) {
    const actual = host.fs.fs.readFileSync(entry.path);
    expect(
      typeof actual === "string" ? new TextEncoder().encode(actual) : Uint8Array.from(actual),
    ).toEqual(entry.bytes);
    expect(host.filesystem.getPosixMetadata(entry.path)).toMatchObject({
      mode: 0o755,
      uid: 1000,
      gid: 1000,
    });
  }
}

describe("proof executable seed transport fixtures", () => {
  it("stores the fixtures in SQLite with executable metadata and survives filesystem reopen", async () => {
    expect(programFixtures.map(({ path }) => path)).toEqual(["/bin/bash", "/bin/cat", "/bin/rg"]);

    const database = createProofTestStorage();
    let host = createProofFilesystemHost(database.storage);
    try {
      const route = createProofExecutableSeedRoute({
        catalog: programFixtureCatalog,
        filesystem: () => host.filesystem,
        storage: database.storage,
      });
      const result = await route.handle(programRequest(programBundle()), {
        bootStarted: false,
        assetsRequired: true,
        assetsSeeded: true,
      });
      expect(result.status).toBe(200);
      expect(await result.json()).toMatchObject({
        ok: true,
        seededPrograms: 3,
        seededBytes: programFixtures.reduce((sum, entry) => sum + entry.bytes.byteLength, 0),
      });
      expect(route.seeded).toBe(true);
      expectStoredProgramFixtures(host);
      await expect(
        route.handle(programRequest(programBundle()), {
          bootStarted: false,
          assetsRequired: true,
          assetsSeeded: true,
        }),
      ).rejects.toThrow("ERR_DIAGNOSTIC_PROGRAM_SEED_ORDER");

      closeHost(host);
      host = createProofFilesystemHost(database.storage);
      expectStoredProgramFixtures(host);
    } finally {
      closeHost(host);
      database.close();
    }
  });

  it("rejects wrong route conditions and tampered fixture bytes before filesystem access", async () => {
    const body = programBundle();
    const database = createProofTestStorage();
    const host = createProofFilesystemHost(database.storage);
    let filesystemRequests = 0;
    try {
      const route = createProofExecutableSeedRoute({
        catalog: programFixtureCatalog,
        filesystem: () => {
          filesystemRequests += 1;
          return host.filesystem;
        },
        storage: database.storage,
      });
      expect(
        (
          await route.handle(programRequest(body, { method: "GET" }), {
            bootStarted: false,
            assetsRequired: true,
            assetsSeeded: true,
          })
        ).status,
      ).toBe(405);
      expect(
        (
          await route.handle(programRequest(body, { contentType: "application/octet-stream" }), {
            bootStarted: false,
            assetsRequired: true,
            assetsSeeded: true,
          })
        ).status,
      ).toBe(415);
      await expect(
        route.handle(programRequest(body), {
          bootStarted: false,
          assetsRequired: true,
          assetsSeeded: false,
        }),
      ).rejects.toThrow("ERR_DIAGNOSTIC_PROGRAM_SEED_ORDER");
      await expect(
        route.handle(programRequest(body), {
          bootStarted: true,
          assetsRequired: true,
          assetsSeeded: true,
        }),
      ).rejects.toThrow("ERR_DIAGNOSTIC_PROGRAM_SEED_ORDER");

      const tampered = body.slice();
      tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
      await expect(
        route.handle(programRequest(tampered), {
          bootStarted: false,
          assetsRequired: true,
          assetsSeeded: true,
        }),
      ).rejects.toThrow("hash mismatch");
      expect(filesystemRequests).toBe(0);
      expect(host.fs.fs.existsSync("/bin/bash")).toBe(false);
      expect(route.seeded).toBe(false);
    } finally {
      closeHost(host);
      database.close();
    }
  });
});
