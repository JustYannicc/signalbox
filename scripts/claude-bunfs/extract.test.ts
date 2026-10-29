// @effect-diagnostics nodeBuiltinImport:off - verifies extracted bytes in temporary Node filesystem fixtures.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import { extract, modulePath } from "./extract.ts";
import { fixture, linkedBytecodeFixture } from "./graph-fixture.ts";

const silenceDiagnostics = { diagnostics: () => {} };

describe("unchanged Bun extraction", () => {
  it.each([
    "/$bunfs/root/../escape",
    "/other/absolute",
    "B:/~BUN/root/../escape",
    "../escape",
    "foo/./bar",
    "foo//bar",
    "manifest.json",
    ".bun-data",
    ".bun-data/graph.bin",
    "C:relative",
    "",
  ])("rejects unsafe or reserved name %j", (name) => {
    expect(() => modulePath(name)).toThrow("Unsafe module path");
  });
  it.each([
    ["/$bunfs/root/cli", "cli"],
    ["B:/~BUN/root/deps/a.js", "deps/a.js"],
  ])("maps %s below the output root", (name, relative) => {
    expect(modulePath(name!)).toBe(relative);
  });
  it("preserves the complete serialized graph as well as raw module contents", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bun-extract-test-"));
    try {
      const input = fixture();
      const binary = NodePath.join(directory, "binary");
      await NodeFSP.writeFile(binary, input.bytes);
      const output = NodePath.join(directory, "out");
      const manifest = await extract(binary, output, silenceDiagnostics);
      expect(await NodeFSP.readFile(NodePath.join(output, "cli"), "utf8")).toBe(
        "export default 1;",
      );
      const graph = await NodeFSP.readFile(NodePath.join(output, manifest.serializedGraph.path!));
      expect(new Uint8Array(graph)).toEqual(input.graph.subarray(0, -8));
      expect(manifest.serializedGraph.sha256).toBe(
        NodeCrypto.createHash("sha256").update(graph).digest("hex"),
      );
      await expect(extract(binary, output, silenceDiagnostics)).rejects.toThrow();
      expect(await NodeFSP.readFile(NodePath.join(output, "cli"), "utf8")).toBe(
        "export default 1;",
      );
      expect((await NodeFSP.readdir(directory)).sort()).toEqual(["binary", "out"]);
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });

  it("reports planned region bytes and write filesystems before materializing payloads", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bun-extract-test-"));
    try {
      const input = fixture();
      const binary = NodePath.join(directory, "binary");
      await NodeFSP.writeFile(binary, input.bytes);
      const output = NodePath.join(directory, "out");
      const events: Record<string, unknown>[] = [];
      const manifest = await extract(binary, output, {
        diagnostics: (event) => events.push(event),
      });
      const plan = events.find((event) => event.event === "bun-extraction-plan");
      const filesystems = events.filter((event) => event.event === "bun-extraction-filesystem");
      const filesystemRoles = filesystems.map((event) => event.role);

      expect(plan).toMatchObject({
        mode: "materialized",
        binaryBytes: input.bytes.length,
        expectedPeakArtifactBytes: input.bytes.length + manifest.serializedGraph.bytes + 17,
        graphBytes: manifest.serializedGraph.bytes,
        moduleRegionBytes: 17,
        payloadBytes: manifest.serializedGraph.bytes + 17,
        regionBytesByKind: {
          contents: { bytes: 17, files: 1 },
          bytecode: { bytes: 0, files: 0 },
        },
      });
      expect(filesystems.length).toBeGreaterThanOrEqual(1);
      expect(filesystemRoles).toEqual(
        expect.arrayContaining([
          "binary-download-partial",
          "final-output-rename",
          "partial-stage-root",
          "serialized-graph-file",
          "module-artifact-root",
          "manifest-file",
          "release-provenance-file",
          "partial-stage-parent",
          "os-tmpdir",
        ]),
      );
      expect(JSON.stringify(filesystems)).toContain("df -hP");
      expect(JSON.stringify(filesystems)).toContain("df -iP");
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });

  it("stores linked bytecode once while preserving each module's bytecode range hash", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bun-extract-test-"));
    try {
      const input = linkedBytecodeFixture();
      const binary = NodePath.join(directory, "binary");
      await NodeFSP.writeFile(binary, input.bytes);
      const output = NodePath.join(directory, "out");

      const manifest = await extract(binary, output, silenceDiagnostics);
      const moduleArtifacts = manifest.modules.map((module) => module.artifacts.bytecode);
      const linked = (
        manifest as unknown as {
          linkedBytecodePayload?: { path?: string; bytes: number; sha256: string };
        }
      ).linkedBytecodePayload;

      expect(linked).toMatchObject({
        path: ".bun-data/linked-bytecode.bin",
        bytes: input.payload.length,
        sha256: NodeCrypto.createHash("sha256").update(input.payload).digest("hex"),
      });
      expect(new Set(moduleArtifacts.map((artifact) => artifact?.path)).size).toBe(1);
      expect(moduleArtifacts.map((artifact) => artifact?.storageOffset)).toEqual([0, 4]);
      expect(moduleArtifacts.map((artifact) => artifact?.bytes)).toEqual([12, 8]);
      expect(moduleArtifacts.map((artifact) => artifact?.sha256)).toEqual([
        NodeCrypto.createHash("sha256").update(input.payload).digest("hex"),
        NodeCrypto.createHash("sha256").update(input.payload.subarray(4)).digest("hex"),
      ]);
      expect(await NodeFSP.readFile(NodePath.join(output, String(linked?.path)))).toEqual(
        Buffer.from(input.payload),
      );
      expect(manifest.materializedPayloadBytes).toBe(
        manifest.serializedGraph.bytes + input.payload.length + 38,
      );
      const storedPayload = await NodeFSP.readFile(NodePath.join(output, String(linked?.path)));
      for (const [index, artifact] of moduleArtifacts.entries()) {
        const start = artifact?.storageOffset ?? 0;
        const actual = storedPayload.subarray(start, start + (artifact?.bytes ?? 0));
        const expected = index === 0 ? input.payload : input.payload.subarray(4);
        expect(actual).toEqual(Buffer.from(expected));
        expect(NodeCrypto.createHash("sha256").update(actual).digest("hex")).toBe(artifact?.sha256);
      }
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });

  it("hashes release regions without materializing payload files", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bun-extract-test-"));
    try {
      const input = fixture();
      const binary = NodePath.join(directory, "binary");
      await NodeFSP.writeFile(binary, input.bytes);
      const output = NodePath.join(directory, "manifest-only");
      const manifest = await extract(binary, output, {
        materialize: false,
        ...silenceDiagnostics,
      });

      expect(manifest.serializedGraph.path).toBeUndefined();
      expect(manifest.serializedGraph.bytes).toBe(input.graph.byteLength - 8);
      expect(manifest.modules[0]?.artifacts.contents?.path).toBeUndefined();
      expect(manifest.modules[0]?.artifacts.contents?.sha256).toBe(
        NodeCrypto.createHash("sha256").update("export default 1;").digest("hex"),
      );
      await expect(NodeFSP.access(NodePath.join(output, ".bun-data/graph.bin"))).rejects.toThrow();
      await expect(NodeFSP.access(NodePath.join(output, "cli"))).rejects.toThrow();
      expect((await NodeFSP.readdir(output)).sort()).toEqual([".bun-data", "manifest.json"]);
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });

  it("removes partial staging and propagates extraction errors", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bun-extract-test-"));
    try {
      const input = fixture();
      input.graph.set(new TextEncoder().encode("/$bunfs/root/../"));
      const binary = NodePath.join(directory, "binary");
      await NodeFSP.writeFile(binary, input.bytes);
      const output = NodePath.join(directory, "manifest-only");

      await expect(
        extract(binary, output, { materialize: false, ...silenceDiagnostics }),
      ).rejects.toThrow("Unsafe module path");
      expect((await NodeFSP.readdir(directory)).sort()).toEqual(["binary"]);
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves a module write error when closing its staged file also fails", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bun-extract-test-"));
    const input = fixture();
    const binary = NodePath.join(directory, "binary");
    const output = NodePath.join(directory, "out");
    const writeFailure = new Error("module region write failed");
    const closeFailure = new Error("module file close failed");
    const originalOpen = NodeFSP.open.bind(NodeFSP);
    const fileOperations = {
      open: async (path: string, flags: string) => {
        const handle = await originalOpen(path, flags);
        if (path.endsWith(`${NodePath.sep}cli`)) {
          vi.spyOn(handle, "writeFile").mockRejectedValue(writeFailure);
          const close = handle.close.bind(handle);
          let firstClose = true;
          vi.spyOn(handle, "close").mockImplementation(async () => {
            await close();
            if (firstClose) {
              firstClose = false;
              throw closeFailure;
            }
          });
        }
        return handle;
      },
      remove: (path: string) => NodeFSP.rm(path, { recursive: true, force: true }),
    };
    try {
      await NodeFSP.writeFile(binary, input.bytes);
      const caught = await extract(binary, output, { fileOperations, ...silenceDiagnostics }).catch(
        (error: unknown) => error,
      );

      expect(caught).toBeInstanceOf(AggregateError);
      if (!(caught instanceof AggregateError)) throw new Error("Expected cleanup failure details.");
      expect(caught.message).toContain(writeFailure.message);
      expect(caught.errors).toEqual(expect.arrayContaining([writeFailure, closeFailure]));
      expect((await NodeFSP.readdir(directory)).sort()).toEqual(["binary"]);
    } finally {
      vi.restoreAllMocks();
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves the extraction error alongside stage removal and source close failures", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bun-extract-test-"));
    const input = fixture();
    input.graph.set(new TextEncoder().encode("/$bunfs/root/../"));
    const binary = NodePath.join(directory, "binary");
    const output = NodePath.join(directory, "manifest-only");
    const removalFailure = new Error("staging removal failed");
    const closeFailure = new Error("source file close failed");
    const originalOpen = NodeFSP.open.bind(NodeFSP);
    const fileOperations = {
      open: async (path: string, flags: string) => {
        const handle = await originalOpen(path, flags);
        if (path === binary) {
          const close = handle.close.bind(handle);
          let firstClose = true;
          vi.spyOn(handle, "close").mockImplementation(async () => {
            await close();
            if (firstClose) {
              firstClose = false;
              throw closeFailure;
            }
          });
        }
        return handle;
      },
      remove: async (path: string) => {
        if (path.startsWith(`${output}.partial-`)) throw removalFailure;
        await NodeFSP.rm(path, { recursive: true, force: true });
      },
    };
    try {
      await NodeFSP.writeFile(binary, input.bytes);
      const caught = await extract(binary, output, {
        materialize: false,
        fileOperations,
        ...silenceDiagnostics,
      }).catch((error: unknown) => error);

      expect(caught).toBeInstanceOf(AggregateError);
      if (!(caught instanceof AggregateError)) throw new Error("Expected cleanup failure details.");
      expect(caught.message).toContain("Unsafe module path");
      expect(caught.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ message: expect.stringContaining("Unsafe module path") }),
          removalFailure,
          closeFailure,
        ]),
      );
    } finally {
      vi.restoreAllMocks();
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });
});
