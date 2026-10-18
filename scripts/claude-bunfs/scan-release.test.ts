// @effect-diagnostics nodeBuiltinImport:off - verify immutable output in temporary test directories.
import { describe, expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { scanClaudeReleaseInventory } from "./release-inventory.ts";
import {
  scanExtractedRelease,
  reportReleaseInventory,
  writeReleaseScan,
  compareReleaseScan,
} from "./scan-release.ts";
import { assertReleaseIsPublishable } from "./release-report.ts";
import { Ajv } from "ajv";

describe("release scan reporting", () => {
  it("fails guarded unmapped APIs and unsupported APIs without feature-off evidence", () => {
    const inventory = scanClaudeReleaseInventory({
      release: { version: "2.1.302", platform: "linux-x64", bunVersion: null },
      binary: { bytes: 100, sha256: "a".repeat(64) },
      graph: { entry: 0, flags: 0, recordSize: 72 },
      modules: [
        {
          index: 0,
          name: "/$bunfs/root/cli",
          key: "$bunfs/root/cli",
          loader: 1,
          bytes: 90,
          source:
            'if (typeof Bun.futureAPI === "function") Bun.futureAPI(); if (typeof Bun.headlessFeature === "function") Bun.headlessFeature();',
        },
      ],
      capabilities: { bunApis: { headlessFeature: "headless" }, nodeBuiltins: {} },
    });
    const report = reportReleaseInventory(inventory);
    expect(inventory.bunCapabilityGaps.map(({ reason, guarded }) => [reason, guarded])).toEqual(
      expect.arrayContaining([
        ["unmapped-api", true],
        ["missing-feature-off-evidence", true],
      ]),
    );
    expect(report.checks.bunCapabilities.status).toBe("fail");
  });

  it("records precise API failures and keeps missing runtime evidence pending", async () => {
    const inventory = scanClaudeReleaseInventory({
      release: { version: "2.1.302", platform: "linux-x64", bunVersion: null },
      binary: { bytes: 100, sha256: "a".repeat(64) },
      graph: { entry: 0, flags: 0, recordSize: 72 },
      modules: [
        {
          index: 0,
          name: "/$bunfs/root/cli",
          key: "$bunfs/root/cli",
          loader: 1,
          bytes: 50,
          source: "export const result=Bun.futureAPI(); new Function('return 1')();",
        },
      ],
      capabilities: { bunApis: {}, nodeBuiltins: {} },
    });
    const report = reportReleaseInventory(inventory);
    expect(report.checks.bunCapabilities.status).toBe("fail");
    expect(report.checks.bunCapabilities.diagnostics).toContainEqual({
      code: "unmapped-api",
      message: "/$bunfs/root/cli:1:21: futureAPI",
    });
    expect(report.checks.codegen.status).toBe("pending");
    expect(report.checks.extraction.status).toBe("pending");
    expect(report.checks.localWorkerd.status).toBe("pending");
    expect(report.checks.deployedDO.status).toBe("pending");
    expect(() => assertReleaseIsPublishable(report)).toThrow("RELEASE_NOT_GREEN");
    const schema = JSON.parse(
      await NodeFSP.readFile(new URL("./release-report.schema.json", import.meta.url), "utf8"),
    );
    const validate = new Ajv({ allErrors: true }).compile(schema);
    expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
    expect(
      validate({ ...report, checks: { ...report.checks, typo: report.checks.inventory } }),
    ).toBe(false);
    expect(
      validate({
        ...report,
        checks: { ...report.checks, rebundle: { status: "pass", diagnostics: [] } },
      }),
    ).toBe(false);
    const diff = compareReleaseScan(inventory, {
      ...inventory,
      release: { ...inventory.release, version: "2.1.303" },
      binary: { ...inventory.binary, bytes: 101 },
    });
    expect(() =>
      compareReleaseScan(
        { ...inventory, release: { ...inventory.release, platform: "darwin-arm64" } },
        inventory,
      ),
    ).toThrow("RELEASE_BASELINE_PLATFORM_MISMATCH");
    const diffSchema = JSON.parse(
      await NodeFSP.readFile(new URL("./release-diff.schema.json", import.meta.url), "utf8"),
    );
    const validateDiff = new Ajv({ allErrors: true }).compile(diffSchema);
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "claude-release-report-"));
    try {
      const output = NodePath.join(root, "scan");
      await writeReleaseScan(output, { inventory, report }, diff);
      expect(
        JSON.parse(await NodeFSP.readFile(NodePath.join(output, "release-report.json"), "utf8")),
      ).toEqual(report);
      const writtenDiff = JSON.parse(
        await NodeFSP.readFile(NodePath.join(output, "diff.json"), "utf8"),
      );
      expect(writtenDiff).toEqual(diff);
      expect(validateDiff(writtenDiff), JSON.stringify(validateDiff.errors)).toBe(true);
      expect(
        validateDiff({
          ...writtenDiff,
          moduleCountChanges: [{ field: "typo", baseline: 1, candidate: 2 }],
        }),
      ).toBe(false);
      await expect(writeReleaseScan(output, { inventory, report })).rejects.toThrow(
        "RELEASE_SCAN_OUTPUT_EXISTS",
      );
      expect(await NodeFSP.readdir(root)).toEqual(["scan"]);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
  it("rejects a damaged non-JavaScript asset before reporting an inventory", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "claude-asset-hash-"));
    try {
      const source = Buffer.from("export const ready=true;");
      const asset = Buffer.from([0, 1, 2, 3]);
      await NodeFSP.writeFile(NodePath.join(root, "entry.js"), source);
      await NodeFSP.writeFile(NodePath.join(root, "asset.bin"), asset);
      await NodeFSP.writeFile(
        NodePath.join(root, "manifest.json"),
        JSON.stringify({
          schemaVersion: 1,
          binary: { bytes: 100, sha256: "a".repeat(64) },
          graph: { entry: 0, flags: 0, recordSize: 72 },
          modules: [
            {
              index: 0,
              name: "/entry.js",
              key: "entry.js",
              loader: 1,
              format: 1,
              encoding: 1,
              artifacts: {
                contents: {
                  path: "entry.js",
                  bytes: source.length,
                  sha256: NodeCrypto.createHash("sha256").update(source).digest("hex"),
                },
              },
            },
            {
              index: 1,
              name: "/asset.bin",
              key: "asset.bin",
              loader: 5,
              format: 0,
              encoding: 0,
              artifacts: {
                contents: { path: "asset.bin", bytes: asset.length, sha256: "b".repeat(64) },
              },
            },
          ],
        }),
      );
      await expect(
        scanExtractedRelease({
          extracted: root,
          version: "2.1.302",
          platform: "linux-x64",
          bunVersion: null,
          capabilities: { bunApis: {}, nodeBuiltins: {} },
        }),
      ).rejects.toThrow("EXTRACTION_HASH_MISMATCH: /asset.bin");
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
  it("carries raw CommonJS format metadata from verified extraction into the scanner", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "claude-raw-cjs-scan-"));
    try {
      const sources = [
        {
          name: "/$bunfs/root/cli.js",
          format: 2,
          source:
            '(function(exports,require,module,__filename,__dirname){require("./child.js");require("./missing.js");require("future-package");require(globalThis.packageName);const fs=require("node:fs");fs.futureAPI();const vm=require("node:vm");vm.compileFunction("return 1");})',
        },
        {
          name: "/$bunfs/root/child.js",
          format: 1,
          source: "export const child=1;WebAssembly.instantiate(new Uint8Array());",
        },
      ];
      const modules = [];
      for (const [index, module] of sources.entries()) {
        const bytes = Buffer.from(module.source, "latin1");
        const path = `source-${index}.js`;
        await NodeFSP.writeFile(NodePath.join(root, path), bytes);
        modules.push({
          index,
          name: module.name,
          key: module.name.slice(1),
          format: module.format,
          loader: 1,
          encoding: 1,
          artifacts: {
            contents: {
              path,
              bytes: bytes.length,
              sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
            },
          },
        });
      }
      await NodeFSP.writeFile(
        NodePath.join(root, "manifest.json"),
        JSON.stringify({
          schemaVersion: 1,
          binary: { bytes: 100, sha256: "a".repeat(64) },
          graph: {
            entry: 0,
            flags: 0,
            recordSize: 72,
            container: "elf",
            offset: 108085256,
            length: 128320322,
            byteCount: 128320274,
          },
          modules,
        }),
      );
      const { inventory, report } = await scanExtractedRelease({
        extracted: root,
        version: "2.1.113",
        platform: "linux-x64",
        bunVersion: null,
        capabilities: { bunApis: {}, nodeBuiltins: {} },
      });
      expect(inventory.modules.reachableJavascriptCount).toBe(2);
      expect(inventory.builtins.map((item) => item.canonicalBuiltin)).toEqual(["fs", "vm"]);
      expect(inventory.codegenFindings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "vm", operation: "vm.compileFunction" }),
          expect.objectContaining({ kind: "WebAssembly.instantiate" }),
        ]),
      );
      expect(report.checks.builtinGaps.status).toBe("fail");
      expect(inventory.graph).toEqual({ entry: 0, flags: 0, recordSize: 72 });
      expect(inventory.unresolvedReferences.map((reference) => reference.kind)).toEqual([
        "internal-module",
        "dynamic-require",
      ]);
      expect(inventory.unresolvedBareReferences.map((reference) => reference.specifier)).toEqual([
        "future-package",
      ]);
      for (const reference of [
        ...inventory.unresolvedReferences,
        ...inventory.unresolvedBareReferences,
      ])
        expect(reference).not.toHaveProperty("literal");
      const schema = JSON.parse(
        await NodeFSP.readFile(new URL("./release-report.schema.json", import.meta.url), "utf8"),
      );
      const validate = new Ajv({ allErrors: true }).compile(schema);
      expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
      const diff = compareReleaseScan(inventory, {
        ...inventory,
        release: { ...inventory.release, version: "2.1.114" },
      });
      const diffSchema = JSON.parse(
        await NodeFSP.readFile(new URL("./release-diff.schema.json", import.meta.url), "utf8"),
      );
      const validateDiff = new Ajv({ allErrors: true }).compile(diffSchema);
      expect(validateDiff(diff), JSON.stringify(validateDiff.errors)).toBe(true);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
