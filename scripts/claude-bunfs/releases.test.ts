// @effect-diagnostics nodeBuiltinImport:off - verifies release downloads with temporary Node filesystem fixtures.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it, vi } from "vite-plus/test";
import { fixture } from "./graph-fixture.ts";
import { extractRelease, requiredVersions, selectedVersions } from "./releases.ts";

it("preserves the required release set and latest selection", () => {
  expect(selectedVersions("latest", "2.1.309")).toEqual(["2.1.309"]);
  expect(selectedVersions("", "2.1.309")).toEqual([...requiredVersions, "2.1.309"]);
  expect(selectedVersions("", "2.1.302")).toEqual(requiredVersions);
});

it("keeps release provenance from overwriting an extracted module", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bun-release-test-"));
  const input = fixture();
  const name = new TextEncoder().encode("/$bunfs/root/release.json");
  input.graph.set(name);
  input.data.setUint32(input.table + 4, name.length, true);
  const manifest = {
    version: "1.2.3",
    platforms: {
      "linux-x64": {
        binary: "claude",
        size: input.bytes.length,
        checksum: NodeCrypto.createHash("sha256").update(input.bytes).digest("hex"),
      },
    },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(manifest)),
  );
  try {
    await NodeFSP.writeFile(NodePath.join(directory, "claude-1.2.3-linux-x64"), input.bytes);
    const output = await extractRelease("1.2.3", directory);
    expect(await NodeFSP.readFile(NodePath.join(output.directory, "release.json"), "utf8")).toBe(
      "export default 1;",
    );
    const provenance = JSON.parse(
      await NodeFSP.readFile(NodePath.join(output.directory, ".bun-data/release.json"), "utf8"),
    );
    expect(provenance.manifest).toEqual(manifest);
  } finally {
    vi.unstubAllGlobals();
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("keeps proof manifests and provenance while discarding its downloaded raw binary", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bun-release-test-"));
  const input = fixture();
  const manifest = {
    version: "1.2.3",
    platforms: {
      "linux-x64": {
        binary: "claude",
        size: input.bytes.length,
        checksum: NodeCrypto.createHash("sha256").update(input.bytes).digest("hex"),
      },
    },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (resource: string | URL | Request) =>
      String(resource).endsWith("manifest.json")
        ? Response.json(manifest)
        : new Response(input.bytes),
    ),
  );
  try {
    const output = await extractRelease("1.2.3", directory, "linux-x64", {
      materialize: false,
      discardDownloadedBinary: true,
    });
    const extracted = JSON.parse(
      await NodeFSP.readFile(NodePath.join(output.directory, "manifest.json"), "utf8"),
    );
    const provenance = JSON.parse(
      await NodeFSP.readFile(NodePath.join(output.directory, ".bun-data/release.json"), "utf8"),
    );

    expect(extracted.binary.sha256).toBe(manifest.platforms["linux-x64"].checksum);
    expect(extracted.modules[0].artifacts.contents.path).toBeUndefined();
    expect(provenance.manifest).toEqual(manifest);
    const manifestBytes = (await NodeFSP.stat(NodePath.join(output.directory, "manifest.json")))
      .size;
    const provenanceBytes = (
      await NodeFSP.stat(NodePath.join(output.directory, ".bun-data/release.json"))
    ).size;
    expect(output.retainedReleaseBytes).toBe(manifestBytes + provenanceBytes);
    expect(await NodeFSP.readdir(directory)).toEqual(["graph-1.2.3-linux-x64"]);
  } finally {
    vi.unstubAllGlobals();
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("cleans only its downloaded input and partial extraction after a failed release", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bun-release-test-"));
  const input = fixture();
  input.graph.set(new TextEncoder().encode("/$bunfs/root/../"));
  const manifest = {
    version: "1.2.3",
    platforms: {
      "linux-x64": {
        binary: "claude",
        size: input.bytes.length,
        checksum: NodeCrypto.createHash("sha256").update(input.bytes).digest("hex"),
      },
    },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (resource: string | URL | Request) =>
      String(resource).endsWith("manifest.json")
        ? Response.json(manifest)
        : new Response(input.bytes),
    ),
  );
  try {
    await expect(
      extractRelease("1.2.3", directory, "linux-x64", {
        materialize: false,
        discardDownloadedBinary: true,
      }),
    ).rejects.toThrow("Unsafe module path");
    expect(await NodeFSP.readdir(directory)).toEqual([]);
  } finally {
    vi.unstubAllGlobals();
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("removes an interrupted binary download and preserves its stream error", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bun-release-test-"));
  const input = fixture();
  const manifest = {
    version: "1.2.3",
    platforms: {
      "linux-x64": {
        binary: "claude",
        size: input.bytes.length,
        checksum: NodeCrypto.createHash("sha256").update(input.bytes).digest("hex"),
      },
    },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (resource: string | URL | Request) => {
      if (String(resource).endsWith("manifest.json")) return Response.json(manifest);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(input.bytes.subarray(0, 64));
          controller.error(new Error("download stream interrupted"));
        },
      });
      return new Response(body);
    }),
  );
  try {
    await expect(
      extractRelease("1.2.3", directory, "linux-x64", {
        materialize: false,
        discardDownloadedBinary: true,
      }),
    ).rejects.toThrow("download stream interrupted");
    expect(await NodeFSP.readdir(directory)).toEqual([]);
  } finally {
    vi.unstubAllGlobals();
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("does not discard a verified binary it did not download", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bun-release-test-"));
  const input = fixture();
  const manifest = {
    version: "1.2.3",
    platforms: {
      "linux-x64": {
        binary: "claude",
        size: input.bytes.length,
        checksum: NodeCrypto.createHash("sha256").update(input.bytes).digest("hex"),
      },
    },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(manifest)),
  );
  try {
    const binary = NodePath.join(directory, "claude-1.2.3-linux-x64");
    await NodeFSP.writeFile(binary, input.bytes);
    await extractRelease("1.2.3", directory, "linux-x64", {
      materialize: false,
      discardDownloadedBinary: true,
    });
    expect(new Uint8Array(await NodeFSP.readFile(binary))).toEqual(input.bytes);
  } finally {
    vi.unstubAllGlobals();
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});
