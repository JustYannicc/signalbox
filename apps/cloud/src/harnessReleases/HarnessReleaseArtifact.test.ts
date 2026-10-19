import { describe, expect, it } from "vite-plus/test";
import { Schema } from "effect";
import {
  HARNESS_RELEASE_ARTIFACT_MANIFEST_PATH,
  HarnessReleaseArtifactManifestSchema,
  openHarnessReleaseArtifact,
  serializeHarnessReleaseArtifactManifest,
  type HarnessReleaseArtifactIdentity,
  type HarnessReleaseArtifactSource,
} from "./HarnessReleaseArtifact.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const decodeArtifactManifest = Schema.decodeUnknownSync(HarnessReleaseArtifactManifestSchema, {
  onExcessProperty: "error",
});
const SOURCE_IDENTITY = "a".repeat(64);
const COMPUTER_SOURCE_IDENTITY = "c".repeat(64);
const COMPUTER_MANIFEST_HASH = "d".repeat(64);
const CLI_MODULE_PATH = "cli/chunks/%2F%24bunfs%2Froot%2Fchunk-00xtx6nv-E7PJ3C3L.js";

const sha256 = async (bytes: Uint8Array) => {
  const input = Uint8Array.from(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", input.buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const asRecord = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an object");
  return value as Record<string, unknown>;
};

const expectCode = (operation: Promise<unknown>, code: string) =>
  expect(operation).rejects.toMatchObject({ code });

const createFixture = async (harness: "codex" | "claude-code" = "codex") => {
  const files = new Map<string, Uint8Array>();
  const reads: string[] = [];
  const payload = new Uint8Array(2_000_000).fill(91);
  const codexRaw = encoder.encode(
    JSON.stringify({ version: "codex-test", modules: ["runtime.js"] }),
  );
  const cliRaw = encoder.encode(
    JSON.stringify({ moduleMap: [{ path: CLI_MODULE_PATH, sha256: await sha256(payload) }] }),
  );
  const sdkRaw = encoder.encode(JSON.stringify({ modules: [] }));
  const components =
    harness === "codex"
      ? { codex: { manifest: "codex/manifest.json" as const } }
      : {
          cli: { manifest: "cli/manifest.json" as const },
          sdk: { manifest: "sdk/manifest.json" as const },
        };
  const rawByPath =
    harness === "codex"
      ? { "codex/manifest.json": codexRaw }
      : { "cli/manifest.json": cliRaw, "sdk/manifest.json": sdkRaw };
  const payloadPath = harness === "codex" ? "codex/runtime.js" : CLI_MODULE_PATH;
  const filesInventory: Record<string, { bytes: number; sha256: string }> = {};
  for (const [path, bytes] of Object.entries(rawByPath)) {
    filesInventory[path] = { bytes: bytes.byteLength, sha256: await sha256(bytes) };
    files.set(path, bytes);
  }
  filesInventory[payloadPath] = { bytes: payload.byteLength, sha256: await sha256(payload) };
  files.set(payloadPath, payload);

  const envelope = {
    schemaVersion: 1 as const,
    harness,
    sourceIdentity: SOURCE_IDENTITY,
    components,
    files: filesInventory,
    computer: {
      sourceIdentity: COMPUTER_SOURCE_IDENTITY,
      manifestSha256: COMPUTER_MANIFEST_HASH,
    },
  };
  let identity: HarnessReleaseArtifactIdentity;
  const installManifestBytes = async (bytes: Uint8Array) => {
    files.set(HARNESS_RELEASE_ARTIFACT_MANIFEST_PATH, bytes);
    const artifactHash = await sha256(bytes);
    identity = {
      artifactRef: `sha256:${artifactHash}`,
      artifactHash,
      sourceIdentity: SOURCE_IDENTITY,
    };
  };
  await installManifestBytes(serializeHarnessReleaseArtifactManifest(envelope));
  const source: HarnessReleaseArtifactSource = {
    async read(artifactRef, path) {
      reads.push(path);
      void artifactRef;
      const bytes = files.get(path);
      if (!bytes) throw new Error(`Missing fixture file: ${path}`);
      return bytes;
    },
  };

  return {
    envelope,
    files,
    reads,
    payload,
    payloadPath,
    source,
    get identity() {
      return identity;
    },
    installManifestBytes,
    async mutateCanonicalEnvelope(mutate: (value: Record<string, unknown>) => void) {
      const bytes = files.get(HARNESS_RELEASE_ARTIFACT_MANIFEST_PATH);
      if (!bytes) throw new Error("Missing fixture envelope");
      const value = asRecord(JSON.parse(decoder.decode(bytes)));
      mutate(value);
      await installManifestBytes(encoder.encode(JSON.stringify(value)));
    },
  };
};

const expectOpenCode = (
  fixture: Awaited<ReturnType<typeof createFixture>>,
  code: string,
  identity = fixture.identity,
) => expectCode(openHarnessReleaseArtifact(identity, fixture.source), code);

describe("harness release artifact reader", () => {
  it("serializes the exported schema as stable canonical UTF-8", async () => {
    const raw = encoder.encode('{"a":1}');
    const expected = `{"components":{"codex":{"manifest":"codex/manifest.json"}},"computer":{"manifestSha256":"${COMPUTER_MANIFEST_HASH}","sourceIdentity":"${COMPUTER_SOURCE_IDENTITY}"},"files":{"codex/manifest.json":{"bytes":7,"sha256":"${await sha256(raw)}"}},"harness":"codex","schemaVersion":1,"sourceIdentity":"${SOURCE_IDENTITY}"}`;
    const serialized = serializeHarnessReleaseArtifactManifest({
      schemaVersion: 1,
      harness: "codex",
      sourceIdentity: SOURCE_IDENTITY,
      components: { codex: { manifest: "codex/manifest.json" } },
      files: {
        "codex/manifest.json": { bytes: raw.byteLength, sha256: await sha256(raw) },
      },
      computer: {
        sourceIdentity: COMPUTER_SOURCE_IDENTITY,
        manifestSha256: COMPUTER_MANIFEST_HASH,
      },
    });

    expect(decoder.decode(serialized)).toBe(expected);
    const manifest = asRecord(JSON.parse(decoder.decode(serialized)));
    expect(() => decodeArtifactManifest({ ...manifest, extra: true })).toThrow();
  });

  it("opens both provider compositions and verifies the literal CLI module-map path", async () => {
    const codex = await createFixture("codex");
    const openedCodex = await openHarnessReleaseArtifact(codex.identity, codex.source);
    expect(openedCodex.rawManifests.codex?.version).toBe("codex-test");
    expect(openedCodex.manifest.harness).toBe("codex");

    const claude = await createFixture("claude-code");
    const openedClaude = await openHarnessReleaseArtifact(claude.identity, claude.source);
    const cliManifest = openedClaude.rawManifests.cli;
    expect(cliManifest?.moduleMap).toEqual([
      { path: CLI_MODULE_PATH, sha256: await sha256(claude.payload) },
    ]);
    const moduleMap = cliManifest?.moduleMap;
    if (!Array.isArray(moduleMap)) throw new Error("Expected the raw CLI module map");
    const moduleEntry = asRecord(moduleMap[0]);
    expect(Object.hasOwn(moduleEntry, "bytes")).toBe(false);
    expect(openedClaude.manifest.files[CLI_MODULE_PATH]?.bytes).toBe(claude.payload.byteLength);
    expect(await openedClaude.read(CLI_MODULE_PATH)).toEqual(claude.payload);
    expect(claude.reads).toContain(CLI_MODULE_PATH);
  });

  it("requires Claude CLI and SDK components to name their own manifests", async () => {
    const fixture = await createFixture("claude-code");
    await fixture.mutateCanonicalEnvelope((envelope) => {
      asRecord(envelope.components).cli = { manifest: "sdk/manifest.json" };
    });

    await expectOpenCode(fixture, "INVALID_COMPONENTS");
    expect(fixture.reads).toEqual([HARNESS_RELEASE_ARTIFACT_MANIFEST_PATH]);
  });

  it("rejects reference, envelope-hash, and source-identity mismatches before returning a reader", async () => {
    const fixture = await createFixture();
    await expectOpenCode(fixture, "ARTIFACT_REF_MISMATCH", {
      ...fixture.identity,
      artifactRef: `sha256:${"0".repeat(64)}`,
    });
    expect(fixture.reads).toHaveLength(0);

    const wrongHash = "0".repeat(64);
    await expectOpenCode(fixture, "MANIFEST_HASH_MISMATCH", {
      ...fixture.identity,
      artifactRef: `sha256:${wrongHash}`,
      artifactHash: wrongHash,
    });

    await expectOpenCode(fixture, "SOURCE_IDENTITY_MISMATCH", {
      ...fixture.identity,
      sourceIdentity: "b".repeat(64),
    });
  });

  it("rejects noncanonical shape, unsafe inventory paths, missing manifests, and invalid provider combinations", async () => {
    const fixture = await createFixture();

    await fixture.mutateCanonicalEnvelope((envelope) => {
      envelope.zExtra = true;
    });
    await expectOpenCode(fixture, "MANIFEST_INVALID");

    await fixture.installManifestBytes(encoder.encode(JSON.stringify(fixture.envelope)));
    await expectOpenCode(fixture, "NON_CANONICAL_MANIFEST");

    await fixture.installManifestBytes(serializeHarnessReleaseArtifactManifest(fixture.envelope));
    await fixture.mutateCanonicalEnvelope((envelope) => {
      asRecord(asRecord(envelope.files)["codex/manifest.json"]).bytes = 1.5;
    });
    await expectOpenCode(fixture, "MANIFEST_INVALID");

    await fixture.installManifestBytes(serializeHarnessReleaseArtifactManifest(fixture.envelope));
    await fixture.mutateCanonicalEnvelope((envelope) => {
      const files = asRecord(envelope.files);
      files["codex/zz/../escaped.js"] = { bytes: 0, sha256: "0".repeat(64) };
    });
    await expectOpenCode(fixture, "UNSAFE_PATH");

    await fixture.installManifestBytes(serializeHarnessReleaseArtifactManifest(fixture.envelope));
    await fixture.mutateCanonicalEnvelope((envelope) => {
      envelope.harness = "claude-code";
    });
    await expectOpenCode(fixture, "INVALID_COMPONENTS");

    await fixture.installManifestBytes(serializeHarnessReleaseArtifactManifest(fixture.envelope));
    await fixture.mutateCanonicalEnvelope((envelope) => {
      delete asRecord(envelope.files)["codex/manifest.json"];
    });
    await expectOpenCode(fixture, "MISSING_COMPONENT_MANIFEST");
  });

  it("rejects a BOM even though the UTF-8 decoder accepts it", async () => {
    const fixture = await createFixture();
    const canonical = fixture.files.get(HARNESS_RELEASE_ARTIFACT_MANIFEST_PATH);
    if (!canonical) throw new Error("Missing fixture envelope");
    const withBom = new Uint8Array(canonical.byteLength + 3);
    withBom.set([0xef, 0xbb, 0xbf]);
    withBom.set(canonical, 3);
    await fixture.installManifestBytes(withBom);

    await expectOpenCode(fixture, "NON_CANONICAL_MANIFEST");
  });

  it("checks exact raw-manifest bytes and requires each provider manifest to be a JSON object", async () => {
    const fixture = await createFixture();
    await fixture.mutateCanonicalEnvelope((envelope) => {
      const files = asRecord(envelope.files);
      const descriptor = asRecord(files["codex/manifest.json"]);
      descriptor.sha256 = "0".repeat(64);
    });
    await expectOpenCode(fixture, "RAW_MANIFEST_HASH_MISMATCH");

    const invalidJson = encoder.encode("[]");
    fixture.files.set("codex/manifest.json", invalidJson);
    await fixture.installManifestBytes(
      serializeHarnessReleaseArtifactManifest({
        ...fixture.envelope,
        files: {
          ...fixture.envelope.files,
          "codex/manifest.json": {
            bytes: invalidJson.byteLength,
            sha256: await sha256(invalidJson),
          },
        },
      }),
    );
    await expectOpenCode(fixture, "RAW_MANIFEST_NOT_OBJECT");
  });

  it("loads only envelope and provider manifests during open, then checks payload size and hash", async () => {
    const fixture = await createFixture();
    await openHarnessReleaseArtifact(fixture.identity, fixture.source);
    expect(fixture.reads).toEqual([HARNESS_RELEASE_ARTIFACT_MANIFEST_PATH, "codex/manifest.json"]);

    const corrupted = Uint8Array.from(fixture.payload);
    corrupted[0] = (corrupted[0] ?? 0) ^ 1;
    fixture.files.set(fixture.payloadPath, corrupted);
    const opened = await openHarnessReleaseArtifact(fixture.identity, fixture.source);
    await expectCode(opened.read(fixture.payloadPath), "FILE_HASH_MISMATCH");

    fixture.files.set(fixture.payloadPath, fixture.payload.slice(0, -1));
    await expectCode(opened.read(fixture.payloadPath), "FILE_SIZE_MISMATCH");
  });

  it("does not fetch undeclared paths and isolates verified bytes from caller and source mutation", async () => {
    const fixture = await createFixture();
    const opened = await openHarnessReleaseArtifact(fixture.identity, fixture.source);
    await expectCode(opened.read("codex/not-declared.js"), "FILE_NOT_DECLARED");
    expect(fixture.reads).not.toContain("codex/not-declared.js");

    expect(Reflect.set(opened.manifest.files[fixture.payloadPath]!, "bytes", 0)).toBe(false);
    expect(Reflect.set(opened.rawManifests.codex!, "version", "tampered")).toBe(false);
    const sourceManifestBytes = fixture.files.get(HARNESS_RELEASE_ARTIFACT_MANIFEST_PATH);
    sourceManifestBytes?.fill(0);
    const returned = await opened.read(fixture.payloadPath);
    returned.fill(0);
    fixture.files.set(fixture.payloadPath, new Uint8Array(fixture.payload.length));

    expect(opened.manifest.sourceIdentity).toBe(SOURCE_IDENTITY);
    expect(opened.rawManifests.codex?.version).toBe("codex-test");
    await expectCode(opened.read(fixture.payloadPath), "FILE_HASH_MISMATCH");
    fixture.files.set(fixture.payloadPath, fixture.payload);
    expect(await opened.read(fixture.payloadPath)).toEqual(fixture.payload);
  });

  it("shares concurrent payload reads, then rechecks bytes on later reads", async () => {
    const fixture = await createFixture();
    const source = fixture.source;
    let payloadReads = 0;
    let releaseFirstRead: (() => void) | undefined;
    const firstReadGate = new Promise<void>((resolve) => {
      releaseFirstRead = resolve;
    });
    const opened = await openHarnessReleaseArtifact(fixture.identity, {
      async read(artifactRef, path) {
        if (path === fixture.payloadPath) {
          payloadReads += 1;
          if (payloadReads === 1) await firstReadGate;
        }
        return source.read(artifactRef, path);
      },
    });

    const first = opened.read(fixture.payloadPath);
    const second = opened.read(fixture.payloadPath);
    expect(payloadReads).toBe(1);
    releaseFirstRead?.();
    const [firstBytes, secondBytes] = await Promise.all([first, second]);
    firstBytes.fill(0);
    expect(secondBytes).toEqual(fixture.payload);
    expect(payloadReads).toBe(1);

    expect(await opened.read(fixture.payloadPath)).toEqual(fixture.payload);
    expect(payloadReads).toBe(2);
  });
});
