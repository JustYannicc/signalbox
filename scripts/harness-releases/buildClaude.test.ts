import { describe, expect, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import type { OfficialReleaseIdentity } from "./releaseIdentity.ts";
import { claudeReleaseBase } from "./releaseIdentity.ts";
import { buildClaudeRelease, parseBuiltinCapabilityManifest } from "./buildClaude.ts";

const digest = (value: Uint8Array | string) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");
const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

async function makeExtraction(root: string, version: string, source: string) {
  const extracted = NodePath.join(root, `extracted-${version}`);
  const payload = Buffer.from(source);
  const binary = Buffer.from(`synthetic-official-binary-${version}`);
  const binarySha256 = digest(binary);
  const officialManifest = {
    version,
    platforms: {
      "linux-x64": {
        binary: "claude",
        size: binary.byteLength,
        checksum: binarySha256,
      },
    },
  };
  await NodeFSP.mkdir(NodePath.join(extracted, ".bun-data"), { recursive: true });
  await NodeFSP.mkdir(NodePath.join(extracted, "source"));
  await NodeFSP.writeFile(NodePath.join(extracted, "source/cli.js"), payload);
  await NodeFSP.writeFile(
    NodePath.join(extracted, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      binary: { bytes: binary.byteLength, sha256: binarySha256 },
      graph: { entry: 0, flags: 0, recordSize: 72 },
      modules: [
        {
          index: 0,
          name: "/$bunfs/root/cli",
          key: "$bunfs/root/cli",
          loader: 1,
          encoding: 0,
          format: 1,
          artifacts: {
            contents: {
              path: "source/cli.js",
              bytes: payload.byteLength,
              sha256: digest(payload),
            },
          },
        },
      ],
    }),
  );
  await NodeFSP.writeFile(
    NodePath.join(extracted, ".bun-data/release.json"),
    JSON.stringify({
      version,
      platform: "linux-x64",
      source: `${claudeReleaseBase}/${version}/linux-x64/claude`,
      manifest: officialManifest,
    }),
  );
  const identityPayload = {
    provider: "claude-code" as const,
    version,
    upstreamIdentity: "npm:@anthropic-ai/claude-code",
    npm: {
      packageName: "@anthropic-ai/claude-code",
      integrity: `sha512-${Buffer.alloc(64, 7).toString("base64")}`,
      tarball: `https://registry.npmjs.org/@anthropic-ai/claude-code/-/claude-code-${version}.tgz`,
    },
    binary: {
      platform: "linux-x64" as const,
      sourceURL: `${claudeReleaseBase}/${version}/linux-x64/claude`,
      bytes: binary.byteLength,
      sha256: binarySha256,
      manifestSha256: digest(JSON.stringify(officialManifest)),
    },
  };
  const identity: OfficialReleaseIdentity = {
    ...identityPayload,
    sha256: digest(JSON.stringify(identityPayload)),
  };
  return { extracted, identity };
}

describe("Claude release build integration", () => {
  it("validates capability snapshots before scanning a release", () => {
    expect(
      parseBuiltinCapabilityManifest({
        bunApis: { "Bun.file": "implemented" },
        nodeBuiltins: {
          fs: {
            available: true,
            defaultImport: true,
            defaultMembers: ["readFile"],
            namespaceImport: true,
            namedExports: ["readFile"],
            commonJs: true,
            commonJsMembers: ["readFile"],
          },
        },
      }).nodeBuiltins.fs,
    ).toEqual({
      available: true,
      defaultImport: true,
      defaultMembers: ["readFile"],
      namespaceImport: true,
      namedExports: ["readFile"],
      commonJs: true,
      commonJsMembers: ["readFile"],
    });
    expect(() =>
      parseBuiltinCapabilityManifest({ bunApis: { "Bun.file": "pass" }, nodeBuiltins: {} }),
    ).toThrow("CLAUDE_CAPABILITY_BUN_API_INVALID");
  });

  it("builds identical source for two exact release identities and leaves proof checks pending", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "claude-build-inputs-"));
    try {
      const source = `
        function unused() { process.getBuiltinModule('cluster'); }
        export const sourceMarker = "same-code";
      `;
      const first = await makeExtraction(root, "2.1.302", source);
      const second = await makeExtraction(root, "2.1.303", source);
      const firstOutput = NodePath.join(root, "artifact-2.1.302");
      const secondOutput = NodePath.join(root, "artifact-2.1.303");
      const identityFile = NodePath.join(root, "identity-2.1.302.json");
      const firstResultPath = NodePath.join(root, "result-2.1.302.json");
      await NodeFSP.writeFile(identityFile, JSON.stringify(first.identity));
      await execFile(
        process.execPath,
        [
          NodePath.resolve(import.meta.dirname, "buildClaude.ts"),
          "--identity",
          identityFile,
          "--extracted",
          first.extracted,
          "--output",
          firstOutput,
          "--result",
          firstResultPath,
        ],
        { cwd: NodePath.resolve(import.meta.dirname, "../..") },
      );
      const firstResult = JSON.parse(await NodeFSP.readFile(firstResultPath, "utf8"));
      const secondResult = await buildClaudeRelease({
        ...second,
        output: secondOutput,
        result: NodePath.join(root, "result-2.1.303.json"),
      });

      const firstManifest = JSON.parse(
        await NodeFSP.readFile(NodePath.join(firstOutput, "manifest.json"), "utf8"),
      );
      const secondManifest = JSON.parse(
        await NodeFSP.readFile(NodePath.join(secondOutput, "manifest.json"), "utf8"),
      );
      expect(firstManifest.release.version).toBe("2.1.302");
      expect(secondManifest.release.version).toBe("2.1.303");
      expect(firstManifest.release.binarySha256).not.toBe(secondManifest.release.binarySha256);
      expect(firstManifest.moduleMap.sha256).toBe(secondManifest.moduleMap.sha256);
      expect(await NodeFSP.readFile(NodePath.join(firstOutput, "claude.js"), "utf8")).toBe(
        await NodeFSP.readFile(NodePath.join(secondOutput, "claude.js"), "utf8"),
      );
      expect(firstResult.artifact.sha256).not.toBe(secondResult.artifact.sha256);
      expect(firstResult.report.checks.extraction.status).toBe("pass");
      expect(firstResult.report.checks.rebundle.status).toBe("pass");
      expect(firstResult.report.checks.builtinGaps.status).toBe("pending");
      expect(firstResult.report.checks.localWorkerd.status).toBe("pending");
      expect(firstResult.report.checks.deployedDO.status).toBe("pending");
      expect(firstResult.report.checks.updateProof.status).toBe("pending");
      expect(
        JSON.parse(await NodeFSP.readFile(NodePath.join(root, "result-2.1.303.json"), "utf8"))
          .artifact,
      ).toEqual(secondResult.artifact);
      expect(await NodeFSP.stat(`${secondOutput}.provenance.json`)).toBeDefined();
      const provenance = JSON.parse(
        await NodeFSP.readFile(`${secondOutput}.provenance.json`, "utf8"),
      );
      expect(provenance.builtinCoverage.artifact.sha256).toBe(secondResult.artifact.sha256);
      expect(provenance.builtinCoverage.requiredBuiltins).not.toContain("cluster");
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects builtin-only process loads before publishing a Claude build", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "claude-build-builtin-"));
    try {
      const input = await makeExtraction(
        root,
        "2.1.303",
        `
        globalThis.process?.getBuiltinModule?.('cluster');
        export const sourceMarker = 'builtin-only';
      `,
      );
      const output = NodePath.join(root, "artifact");
      await expect(buildClaudeRelease({ ...input, output })).rejects.toThrow(
        "NODE_BUILTIN_COVERAGE_FAILED: missing=cluster",
      );
      await expect(NodeFSP.lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(NodeFSP.lstat(`${output}.provenance.json`)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(
        (await NodeFSP.readdir(root)).filter((name) => name.startsWith("artifact.rejected-")),
      ).toHaveLength(1);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("retains rejected build evidence and does not publish a damaged graph", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "claude-build-tamper-"));
    try {
      const { extracted, identity } = await makeExtraction(
        root,
        "2.1.304",
        'export const sourceMarker = "before-tamper";\n',
      );
      await NodeFSP.writeFile(
        NodePath.join(extracted, "source/cli.js"),
        'export const sourceMarker = "after-tamper";\n',
      );
      const output = NodePath.join(root, "artifact");
      const result = NodePath.join(root, "result.json");
      await expect(buildClaudeRelease({ identity, extracted, output, result })).rejects.toThrow(
        "EXTRACTION_HASH_MISMATCH",
      );
      expect(
        await NodeFSP.lstat(output).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
      expect(
        await NodeFSP.lstat(`${output}.provenance.json`).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
      expect(
        await NodeFSP.lstat(result).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
      expect(
        (await NodeFSP.readdir(root)).some((name) => name.startsWith("artifact.rejected-")),
      ).toBe(true);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
