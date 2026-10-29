import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import type { MachineProgramInventory } from "../../src/computer/MachineProgramInventory.ts";
import { runTrustedComputerManifestCli } from "./computerManifestCli.ts";
import {
  canonicalComputerJson,
  createTrustedComputerIdentity,
  describePreparedAsset,
  describePreparedModules,
  type TrustedComputerIdentityInputs,
  type TrustedComputerPreparedCommands,
  type TrustedComputerSourceFreeze,
} from "./computerManifest/identity.ts";

const sha256 = (bytes: string | Uint8Array) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

it("rejects an output inside the checkout before reading program inputs", async () => {
  const repository = NodePath.resolve(import.meta.dirname, "../../../..");
  await expect(
    runTrustedComputerManifestCli([
      "--programs",
      "/missing-programs",
      "--machine-inventory",
      "/missing-inventory",
      "--result",
      NodePath.join(repository, ".trusted-computer-test-output"),
    ]),
  ).rejects.toThrow("TRUSTED_COMPUTER_OUTPUT_MUST_BE_OUTSIDE_REPOSITORY");
});

it("accepts an external output path and proceeds to input validation", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "computer-output-"));
  try {
    await expect(
      runTrustedComputerManifestCli([
        "--programs",
        "/missing-programs",
        "--machine-inventory",
        NodePath.join(root, "missing-inventory"),
        "--result",
        NodePath.join(root, "identity.json"),
      ]),
    ).rejects.toThrow("ENOENT");
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

describe("trusted Computer source identity", () => {
  it("changes when a frozen product source file changes bytes", () => {
    const before = createTrustedComputerIdentity(
      identityInputs({ sourceText: "first", moduleText: "same" }),
    );
    const after = createTrustedComputerIdentity(
      identityInputs({ sourceText: "second", moduleText: "same" }),
    );

    expect(after.trustedComputer.sourceIdentity).not.toBe(before.trustedComputer.sourceIdentity);
    expect(after.trustedComputer.manifestSha256).not.toBe(before.trustedComputer.manifestSha256);
  });

  it("changes when a prepared command module changes bytes", () => {
    const before = createTrustedComputerIdentity(
      identityInputs({ sourceText: "same", moduleText: "first" }),
    );
    const after = createTrustedComputerIdentity(
      identityInputs({ sourceText: "same", moduleText: "second" }),
    );

    expect(after.trustedComputer.sourceIdentity).not.toBe(before.trustedComputer.sourceIdentity);
    expect(after.trustedComputer.manifestSha256).not.toBe(before.trustedComputer.manifestSha256);
  });

  it("changes when a prepared command asset changes bytes", () => {
    const before = createTrustedComputerIdentity(
      identityInputs({ sourceText: "same", moduleText: "same", assetText: "first asset" }),
    );
    const after = createTrustedComputerIdentity(
      identityInputs({ sourceText: "same", moduleText: "same", assetText: "second asset" }),
    );

    expect(after.trustedComputer.sourceIdentity).not.toBe(before.trustedComputer.sourceIdentity);
    expect(after.trustedComputer.manifestSha256).not.toBe(before.trustedComputer.manifestSha256);
  });

  it("hashes the documented canonical source and manifest bytes", () => {
    const identity = createTrustedComputerIdentity(
      identityInputs({ sourceText: "source", moduleText: "module" }),
    );

    expect(identity.trustedComputer.sourceIdentity).toBe(
      sha256(canonicalComputerJson(identity.manifest.identityInputs)),
    );
    expect(identity.trustedComputer.manifestSha256).toBe(
      sha256(canonicalComputerJson(identity.manifest)),
    );
  });

  it("pins prepared asset and module descriptors to their actual bytes", () => {
    const assetBytes = new TextEncoder().encode("pinned command asset");
    const asset = describePreparedAsset({
      path: "/bin/example",
      bytes: assetBytes,
      sha256: sha256(assetBytes),
      mode: 0o755,
    });
    const modules = describePreparedModules({
      mainModule: "main.js",
      modules: { "main.js": { js: "export default 1;" } },
    });

    expect(asset).toEqual({
      path: "/bin/example",
      bytes: assetBytes.byteLength,
      sha256: sha256(assetBytes),
      mode: 0o755,
    });
    expect(modules).toEqual([
      {
        path: "main.js",
        bytes: new TextEncoder().encode("export default 1;").byteLength,
        sha256: sha256("export default 1;"),
      },
    ]);
    expect(() =>
      describePreparedAsset({ ...asset, bytes: new TextEncoder().encode("changed bytes") }),
    ).toThrow("TRUSTED_COMPUTER_ASSET_HASH_MISMATCH");
  });
});

function identityInputs({
  sourceText,
  moduleText,
  assetText,
}: {
  readonly sourceText: string;
  readonly moduleText: string;
  readonly assetText?: string;
}): TrustedComputerIdentityInputs {
  const source = sourceFreeze(sourceText);
  const assetBytes = new TextEncoder().encode(assetText ?? "command asset");
  const asset = describePreparedAsset({
    path: "/bin/example",
    bytes: assetBytes,
    sha256: sha256(assetBytes),
    mode: 0o755,
  });
  const module = describePreparedModules({
    mainModule: "main.js",
    modules: { "main.js": { js: moduleText } },
  });
  const commands = {
    sourceInventory: {
      format: "signalbox-child-programs-v1",
      sources: [],
      artifacts: [],
      programs: {},
    },
    executableCatalog: {},
    executableFiles: [asset],
    dataCatalog: {},
    dataFiles: [],
    programs: { example: { modules: module } },
  } as unknown as TrustedComputerPreparedCommands;
  return {
    source,
    compilerVersions: {
      childProgramTypeStripper: {
        implementation: "node:module.stripTypeScriptTypes",
        node: "v24.13.1",
      },
      esbuild: { implementation: "esbuild", version: "0.28.2" },
    },
    machineInventory: machineInventory(),
    commands,
  };
}

function sourceFreeze(sourceText: string): TrustedComputerSourceFreeze {
  const file = {
    path: "apps/cloud/src/computer/ProductComputer.ts",
    executable: false,
    bytes: new TextEncoder().encode(sourceText).byteLength,
    sha256: sha256(sourceText),
  };
  const files = [file];
  return {
    commit: "c".repeat(40),
    sha256: sha256(JSON.stringify(files)),
    files,
  };
}

function machineInventory(): MachineProgramInventory {
  const imageDigest = `sha256:${"a".repeat(64)}` as const;
  return {
    format: "signalbox-machine-files-v1",
    imageRef: `registry.example/computer@${imageDigest}`,
    imageDigest,
    platform: "linux/amd64",
    provenance: {
      sourceRevision: "b".repeat(40),
      sourceImageId: `sha256:${"d".repeat(64)}`,
      dockerfile: "Dockerfile",
      captureSha256: "e".repeat(64),
    },
    path: ["/usr/bin"],
    excludedRoots: ["/proc"],
    entries: [
      {
        path: "/",
        type: "directory",
        size: "0",
        nlink: "2",
        atimeNs: "0",
        mtimeNs: "0",
        ctimeNs: "0",
        mode: 0o755,
        uid: 0,
        gid: 0,
      },
    ],
  };
}
