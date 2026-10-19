// @effect-diagnostics nodeBuiltinImport:off - uses transport fixtures and an in-memory SQL database.
import * as NodeCrypto from "node:crypto";
import { describe, expect, it } from "@effect/vitest";
import { encodeAssetBundle, PROGRAM_BUNDLE_CONTENT_TYPE } from "../claudeTurnProof/assetBundle.ts";
import { createProofFilesystemHost } from "../claudeTurnProof/proofFilesystem.ts";
import { createProofTestStorage } from "../claudeTurnProof/proofTestStorage.ts";
import { createClaudeHooksSeedState } from "./ClaudeHooksSeedState.ts";

const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const asset = {
  path: "/work/hooks/fixture.bin",
  bytes: Uint8Array.from([0, 3, 7, 11, 255]),
};
const programFixtures = [
  { path: "/bin/bash", bytes: new TextEncoder().encode("bash proof fixture\n") },
  { path: "/bin/cat", bytes: new TextEncoder().encode("cat proof fixture\n") },
  { path: "/bin/rg", bytes: new TextEncoder().encode("rg proof fixture\n") },
] as const;
const programEntries = programFixtures.map(({ path, bytes }) => ({
  path,
  bytes,
  sha256: sha256(bytes),
}));
const assetCatalog = Object.freeze({
  [asset.path]: { bytes: asset.bytes.byteLength, sha256: sha256(asset.bytes) },
});
const programCatalog = Object.freeze(
  Object.fromEntries(
    programFixtures.map(({ path, bytes }) => [
      path,
      { bytes: bytes.byteLength, sha256: sha256(bytes) },
    ]),
  ),
);

function request(
  path: string,
  contentType: string,
  entries: Parameters<typeof encodeAssetBundle>[0],
) {
  const body = encodeAssetBundle(entries);
  const bodyBuffer = new ArrayBuffer(body.byteLength);
  new Uint8Array(bodyBuffer).set(body);
  return new Request(`https://proof.invalid${path}`, {
    method: "POST",
    headers: { "content-type": contentType },
    body: bodyBuffer,
  });
}

const assetRequest = () =>
  request("/seed-assets", "application/vnd.signalbox.claude-assets.v1", [
    { ...asset, sha256: sha256(asset.bytes) },
  ]);
const programRequest = () => request("/seed-programs", PROGRAM_BUNDLE_CONTENT_TYPE, programEntries);

function createSeedState(
  storage: ReturnType<typeof createProofTestStorage>["storage"],
  host: ReturnType<typeof createProofFilesystemHost>,
  catalogs: {
    readonly assets?: typeof assetCatalog;
    readonly programs?: typeof programCatalog;
  } = {},
) {
  return createClaudeHooksSeedState({
    storage,
    filesystem: () => host,
    assets: catalogs.assets ?? assetCatalog,
    programs: catalogs.programs ?? programCatalog,
    requireSeed: true,
  });
}

function closeHost(host: ReturnType<typeof createProofFilesystemHost>) {
  host.filesystem.dispose();
  host.persistence.dispose();
  host.wakes.dispose();
}

function expectFileBytes(
  host: ReturnType<typeof createProofFilesystemHost>,
  path: string,
  expected: Uint8Array,
) {
  const stored = host.fs.fs.readFileSync(path);
  expect(
    typeof stored === "string" ? new TextEncoder().encode(stored) : Uint8Array.from(stored),
  ).toEqual(expected);
}

async function seedAll(
  storage: ReturnType<typeof createProofTestStorage>["storage"],
  host: ReturnType<typeof createProofFilesystemHost>,
) {
  const seed = createSeedState(storage, host);
  expect((await seed.seedAssets(assetRequest())).status).toBe(200);
  expect((await seed.seedPrograms(programRequest())).status).toBe(200);
}

async function expectReconstructedBootRejected(
  change: (host: ReturnType<typeof createProofFilesystemHost>) => void,
  options: {
    readonly assets?: typeof assetCatalog;
    readonly programs?: typeof programCatalog;
    readonly error: string;
  },
) {
  const database = createProofTestStorage();
  let host = createProofFilesystemHost(database.storage);
  try {
    await seedAll(database.storage, host);
    closeHost(host);
    host = createProofFilesystemHost(database.storage);
    change(host);
    const seed = createSeedState(database.storage, host, options);
    await expect(seed.beginBoot()).rejects.toThrow(options.error);
  } finally {
    closeHost(host);
    database.close();
  }
}

describe("Claude hooks seed lifecycle", () => {
  it("continues asset and program seeding after each fresh host reconstruction", async () => {
    const database = createProofTestStorage();
    let host = createProofFilesystemHost(database.storage);
    try {
      let seed = createSeedState(database.storage, host);
      expect((await seed.seedAssets(assetRequest())).status).toBe(200);
      closeHost(host);

      host = createProofFilesystemHost(database.storage);
      seed = createSeedState(database.storage, host);
      const programResult = await seed.seedPrograms(programRequest());
      expect(programResult.status).toBe(200);
      expect(await programResult.json()).toMatchObject({ ok: true, seededPrograms: 3 });
      expectFileBytes(host, asset.path, asset.bytes);
      for (const entry of programFixtures) {
        expectFileBytes(host, entry.path, entry.bytes);
        expect(host.filesystem.getPosixMetadata(entry.path)).toMatchObject({
          mode: 0o755,
          uid: 1000,
          gid: 1000,
        });
      }
      closeHost(host);

      host = createProofFilesystemHost(database.storage);
      seed = createSeedState(database.storage, host);
      expectFileBytes(host, asset.path, asset.bytes);
      await expect(seed.seedAssets(assetRequest())).rejects.toThrow(
        "ERR_DIAGNOSTIC_ASSET_SEED_ORDER",
      );
      await expect(seed.seedPrograms(programRequest())).rejects.toThrow(
        "ERR_DIAGNOSTIC_PROGRAM_SEED_ORDER",
      );
      await expect(seed.beginBoot()).resolves.toEqual({
        assetsSeeded: true,
        programsSeeded: true,
      });
      closeHost(host);

      host = createProofFilesystemHost(database.storage);
      seed = createSeedState(database.storage, host);
      await expect(seed.beginBoot()).rejects.toThrow("ERR_DIAGNOSTIC_BOOT_ALREADY_STARTED");
      await expect(seed.seedAssets(assetRequest())).rejects.toThrow(
        "ERR_DIAGNOSTIC_ASSET_SEED_ORDER",
      );
    } finally {
      closeHost(host);
      database.close();
    }
  });

  it("rejects changed fixture bytes, missing files and catalogs after reconstruction", async () => {
    const wrongAssetBytes = Uint8Array.from([0, 3, 7, 11, 254]);
    const wrongAssetCatalog = Object.freeze({
      [asset.path]: { bytes: asset.bytes.byteLength, sha256: sha256(wrongAssetBytes) },
    });
    const wrongProgramBytes = new TextEncoder().encode("other bash fixture\n");
    const wrongProgramCatalog = Object.freeze({
      ...programCatalog,
      "/bin/bash": { bytes: wrongProgramBytes.byteLength, sha256: sha256(wrongProgramBytes) },
    });

    await expectReconstructedBootRejected(
      (host) => host.fs.fs.writeFileSync(asset.path, wrongAssetBytes),
      { error: "ERR_DIAGNOSTIC_ASSETS_NOT_SEEDED" },
    );
    await expectReconstructedBootRejected((host) => host.fs.fs.unlinkSync(asset.path), {
      error: "ERR_DIAGNOSTIC_ASSETS_NOT_SEEDED",
    });
    await expectReconstructedBootRejected(
      (host) => host.fs.fs.writeFileSync("/bin/bash", wrongProgramBytes),
      { error: "ERR_DIAGNOSTIC_PROGRAMS_NOT_SEEDED" },
    );
    await expectReconstructedBootRejected((host) => host.filesystem.chmod("/bin/bash", 0o700), {
      error: "ERR_DIAGNOSTIC_PROGRAMS_NOT_SEEDED",
    });
    await expectReconstructedBootRejected((host) => host.fs.fs.unlinkSync("/bin/bash"), {
      error: "ERR_DIAGNOSTIC_PROGRAMS_NOT_SEEDED",
    });
    await expectReconstructedBootRejected(() => {}, {
      assets: wrongAssetCatalog,
      error: "ERR_DIAGNOSTIC_ASSETS_NOT_SEEDED",
    });
    await expectReconstructedBootRejected(() => {}, {
      programs: wrongProgramCatalog,
      error: "ERR_DIAGNOSTIC_PROGRAMS_NOT_SEEDED",
    });
  });
});
