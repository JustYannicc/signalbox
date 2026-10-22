import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { openHarnessReleaseArtifact } from "../../src/harnessReleases/HarnessReleaseArtifact.ts";
import { harnessArtifactKey } from "../../src/harnessReleases/HarnessReleaseArtifactBucket.ts";
import { prepareHarnessArtifact } from "./prepareArtifact.ts";
import { cloudflareHarnessArtifactStore, publishHarnessArtifact } from "./publishArtifact.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});
const setup = async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "1072-artifact-publish-"));
  roots.push(root);
  const codex = NodePath.join(root, "codex");
  await NodeFSP.mkdir(codex);
  await NodeFSP.writeFile(NodePath.join(codex, "manifest.json"), '{"version":"test"}');
  await NodeFSP.writeFile(NodePath.join(codex, "engine.wasm"), new Uint8Array([0, 97, 115, 109]));
  const output = NodePath.join(root, "output");
  const identity = await prepareHarnessArtifact({
    harness: "codex",
    sourceIdentity: "a".repeat(64),
    computer: { sourceIdentity: "b".repeat(64), manifestSha256: "c".repeat(64) },
    components: { codex },
    output,
  });
  return { identity, output };
};

const record = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an object");
  return value as Record<string, unknown>;
};

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = record(value);
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Expected JSON value");
  return serialized;
};

const hash = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

async function setupRehashedQualificationArtifact() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "1072-qualified-publish-"));
  const cli = NodePath.join(root, "cli");
  const sdk = NodePath.join(root, "sdk");
  await NodeFSP.mkdir(cli);
  await NodeFSP.mkdir(sdk);
  const omission = {
    schemaVersion: 1,
    configuration: { name: "product", env: {} },
    configurationReplacements: {},
    configurationRemoved: [],
    corpus: null,
    chunks: [],
  };
  await NodeFSP.writeFile(NodePath.join(cli, "manifest.json"), JSON.stringify({ omission }));
  await NodeFSP.writeFile(NodePath.join(cli, "main.js"), "export const launch = () => {};\n");
  await NodeFSP.writeFile(NodePath.join(sdk, "manifest.json"), "{}\n");
  await NodeFSP.writeFile(NodePath.join(sdk, "sdk.js"), "export const initialize = () => {};\n");
  const output = NodePath.join(root, "output");
  const prepared = await prepareHarnessArtifact({
    harness: "claude-code",
    sourceIdentity: "a".repeat(64),
    computer: { sourceIdentity: "b".repeat(64), manifestSha256: "c".repeat(64) },
    components: { cli, sdk },
    output,
  });

  const providerManifestPath = NodePath.join(output, "cli/manifest.json");
  const providerManifest = record(JSON.parse(await NodeFSP.readFile(providerManifestPath, "utf8")));
  const providerOmission = record(providerManifest.omission);
  record(providerOmission.configuration).name = "qualification";
  const providerBytes = new TextEncoder().encode(JSON.stringify(providerManifest));
  await NodeFSP.writeFile(providerManifestPath, providerBytes);

  const artifactManifestPath = NodePath.join(output, "manifest.json");
  const artifactManifest = record(JSON.parse(await NodeFSP.readFile(artifactManifestPath, "utf8")));
  const files = record(artifactManifest.files);
  files["cli/manifest.json"] = { bytes: providerBytes.byteLength, sha256: hash(providerBytes) };
  artifactManifest.omission = { configuration: { name: "qualification" } };
  const artifactBytes = new TextEncoder().encode(canonicalJson(artifactManifest));
  await NodeFSP.writeFile(artifactManifestPath, artifactBytes);
  const artifactHash = hash(artifactBytes);
  return {
    root,
    output,
    identity: {
      ...prepared,
      artifactRef: `sha256:${artifactHash}`,
      artifactHash,
    },
  };
}

describe("Harness artifact publication", () => {
  it("publishes a reopenable composition after every file passes storage readback", async () => {
    const { identity, output } = await setup();
    const objects = new Map<string, Uint8Array>();
    const writes: string[] = [];
    const store = {
      put: async (key: string, bytes: Uint8Array) => {
        writes.push(key);
        objects.set(key, Uint8Array.from(bytes));
      },
      read: async (key: string) => {
        const bytes = objects.get(key);
        if (!bytes) throw new Error("missing");
        return Uint8Array.from(bytes);
      },
    };
    const result = await publishHarnessArtifact(identity, output, { store, projectId: "alpha" });
    const source = {
      read: async (reference: string, path: string) =>
        store.read(harnessArtifactKey("alpha", reference, path)),
    };
    const reopened = await openHarnessReleaseArtifact(identity, source);
    expect(Array.from(await reopened.read("codex/engine.wasm"))).toEqual([0, 97, 115, 109]);
    expect(result.artifactRef).toBe(identity.artifactRef);
    expect(writes.at(-1)).toBe(harnessArtifactKey("alpha", identity.artifactRef, "manifest.json"));
  });

  it("withholds the manifest when storage mutates a payload and its supplied buffer", async () => {
    const { identity, output } = await setup();
    const objects = new Map<string, Uint8Array>();
    const store = {
      put: async (key: string, bytes: Uint8Array) => {
        bytes[0] = 255;
        objects.set(key, bytes);
      },
      read: async (key: string) => objects.get(key) ?? new Uint8Array(),
    };
    await expect(
      publishHarnessArtifact(identity, output, { store, projectId: "alpha" }),
    ).rejects.toThrow("HARNESS_ARTIFACT_UPLOAD_READBACK_FAILED");
    expect(objects.has(harnessArtifactKey("alpha", identity.artifactRef, "manifest.json"))).toBe(
      false,
    );
  });

  it("rejects a rehashed qualification artifact before product publication writes", async () => {
    const fixture = await setupRehashedQualificationArtifact();
    const writes: string[] = [];
    try {
      await expect(
        publishHarnessArtifact(fixture.identity, fixture.output, {
          store: {
            put: async (key) => void writes.push(key),
            read: async () => new Uint8Array(),
          },
          projectId: "alpha",
        }),
      ).rejects.toThrow("HARNESS_ARTIFACT_QUALIFICATION_ONLY");
      expect(writes).toEqual([]);
    } finally {
      await NodeFSP.rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("escapes literal object-key percent characters once in the Cloudflare request", async () => {
    const urls: string[] = [];
    const store = cloudflareHarnessArtifactStore({
      account: "a".repeat(32),
      bucket: "example-bucket",
      token: "test-token",
      fetcher: async (request) => {
        urls.push(String(request));
        return Response.json({ success: true });
      },
    });
    await store.put("harness-releases/alpha/cli/chunks/%2F%24bunfs.js", new Uint8Array([1]));
    expect(urls[0]).toContain("/cli/chunks/%252F%2524bunfs.js");
    const refused = cloudflareHarnessArtifactStore({
      account: "a".repeat(32),
      bucket: "example-bucket",
      token: "test-token",
      fetcher: async () => Response.json({ success: false }),
    });
    await expect(refused.put("manifest.json", new Uint8Array())).rejects.toThrow(
      "HARNESS_ARTIFACT_STORAGE_WRITE_REJECTED",
    );
  });
});
