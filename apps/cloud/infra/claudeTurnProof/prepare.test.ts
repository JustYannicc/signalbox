// @effect-diagnostics nodeBuiltinImport:off - builds an isolated proof fixture without booting an agent.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { decodeVerifiedAssetBundle } from "./assetBundle.ts";
import { prepareClaudeTurnProof } from "./prepare.ts";
import { prepareProofProgramModules } from "./prepareProgramModules.ts";

const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

async function releaseFixture() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "claude-turn-prepare-test-"));
  const releaseDir = NodePath.join(root, "release");
  const modulePath = "modules/release-entry.js";
  const assetPath = "assets/fixture.bin";
  const moduleBytes = new TextEncoder().encode("export async function launch() {}\n");
  const assetBytes = new Uint8Array([0, 1, 127, 255]);
  await NodeFSP.mkdir(NodePath.join(releaseDir, "modules"), { recursive: true });
  await NodeFSP.mkdir(NodePath.join(releaseDir, "assets"), { recursive: true });
  await NodeFSP.writeFile(NodePath.join(releaseDir, modulePath), moduleBytes);
  await NodeFSP.writeFile(NodePath.join(releaseDir, assetPath), assetBytes);
  await NodeFSP.writeFile(
    NodePath.join(releaseDir, "manifest.json"),
    `${JSON.stringify(
      {
        mainModule: "release-entry.js",
        mainExport: "launch",
        release: { version: "proof-fixture" },
        modules: {
          "release-entry.js": {
            path: modulePath,
            type: "js",
            bytes: moduleBytes.byteLength,
            sha256: sha256(moduleBytes),
          },
        },
        assets: {
          "/claude/fixture.bin": {
            path: assetPath,
            bytes: assetBytes.byteLength,
            sha256: sha256(assetBytes),
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  return { root, releaseDir, moduleBytes, assetBytes };
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await NodeFSP.readFile(path, "utf8")) as T;
}

describe("Claude turn proof preparation", () => {
  it("rejects caller files that do not match the production executable pins", async () => {
    const root = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "claude-turn-artifacts-test-"),
    );
    const wrongBytes = new TextEncoder().encode("wrong artifact fixture\n");
    const paths = {
      bash: NodePath.join(root, "bash.wasm"),
      busybox: NodePath.join(root, "busybox.wasm"),
      ripgrep: NodePath.join(root, "rg.wasm"),
    };
    try {
      await Promise.all(Object.values(paths).map((path) => NodeFSP.writeFile(path, wrongBytes)));

      // The production helper supplies the pins; this test controls only caller-owned files.
      await expect(prepareProofProgramModules(paths)).rejects.toThrow(
        "artifact does not match its pinned bytes and SHA-256",
      );
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps assets-only and packages-only requests with asset transport accounting", async () => {
    const fixture = await releaseFixture();
    const assetsOutput = NodePath.join(fixture.root, "prepared-assets");
    const packagesOutput = NodePath.join(fixture.root, "prepared-packages");
    try {
      const assetsSummary = await prepareClaudeTurnProof({
        releaseDir: fixture.releaseDir,
        outputDir: assetsOutput,
        assetsOnly: true,
      });
      const packagesSummary = await prepareClaudeTurnProof({
        releaseDir: fixture.releaseDir,
        outputDir: packagesOutput,
        packagesOnly: true,
      });
      const assetsManifest = await readJson<{ requests: Array<{ path: string; method: string }> }>(
        NodePath.join(assetsOutput, "manifest.json"),
      );
      const packagesManifest = await readJson<{ paths: string[] }>(
        NodePath.join(packagesOutput, "manifest.json"),
      );
      expect(assetsManifest.requests).toEqual([
        {
          path: "/seed-assets",
          method: "POST",
          bodyFile: "assets.bundle",
          contentType: "application/vnd.signalbox.claude-assets.v1",
        },
        { path: "/verify-assets", method: "GET" },
      ]);
      expect(packagesManifest.paths).toEqual(["/verify-packages"]);
      const assetBundle = new Uint8Array(
        await NodeFSP.readFile(NodePath.join(assetsOutput, "assets.bundle")),
      );
      expect(
        await decodeVerifiedAssetBundle(assetBundle, {
          "/claude/fixture.bin": {
            bytes: fixture.assetBytes.byteLength,
            sha256: sha256(fixture.assetBytes),
          },
        }),
      ).toMatchObject([{ path: "/claude/fixture.bin", bytes: fixture.assetBytes }]);
      expect(assetsSummary).toMatchObject({
        assetCount: 1,
        assetBytes: fixture.assetBytes.byteLength,
        assetBundleBytes: assetBundle.byteLength,
        seeded: true,
        assetsOnly: true,
        moduleCount: 2,
      });
      expect(assetsSummary.moduleMapBytes).toBe(
        fixture.moduleBytes.byteLength + assetsSummary.hostBytes,
      );
      expect(packagesSummary).toMatchObject({ packagesOnly: true, seeded: false });
      expect(
        await NodeFSP.stat(NodePath.join(assetsOutput, "programs.bundle")).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
      expect(
        await NodeFSP.stat(NodePath.join(packagesOutput, "programs.bundle")).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
    } finally {
      await NodeFSP.rm(fixture.root, { recursive: true, force: true });
    }
  });
});
