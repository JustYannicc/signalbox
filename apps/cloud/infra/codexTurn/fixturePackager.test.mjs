import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { createCodexFixture } from "./fixturePackager.mjs";

const roots = [];
const hash = (b) => NodeCrypto.createHash("sha256").update(b).digest("hex");
NodeTest.afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

async function setup() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "1069-fixture-"));
  roots.push(root);
  const artifact = NodePath.join(root, "arbitrary-immutable-bundle");
  await NodeFSP.mkdir(artifact, { recursive: true });
  const engine = Buffer.from([0, 97, 115, 109, 1, 0]);
  const loader = Buffer.from("export default async function load() {}\n");
  const entry = NodePath.join(root, "entry.js");
  await NodeFSP.writeFile(NodePath.join(artifact, "engine.wasm"), engine);
  await NodeFSP.writeFile(NodePath.join(artifact, "loader.mjs"), loader);
  await NodeFSP.writeFile(entry, "export class ProbeFacet {}\n");
  const manifest = {
    target: "wasm32-wasip1",
    version: "0.1.2",
    abiVersion: 1,
    moduleSha256: hash(engine),
    moduleBytes: engine.length,
    files: {
      "engine.wasm": { sha256: hash(engine), bytes: engine.length },
      "loader.mjs": { sha256: hash(loader), bytes: loader.length },
    },
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  await NodeFSP.writeFile(NodePath.join(artifact, "manifest.json"), manifestBytes);
  return {
    root,
    artifact,
    entry,
    output: NodePath.join(root, "out"),
    manifestSha: hash(manifestBytes),
    engine,
    loader,
  };
}

function packageWith(f, additionalModules, id = "codex-extra") {
  return createCodexFixture({
    artifactDir: f.artifact,
    additionalModules,
    expectedManifestSha256: f.manifestSha,
    entryModulePath: f.entry,
    outputDir: f.output,
    paths: ["/status"],
    id,
  });
}

NodeTest.test(
  "packages unchanged artifact bytes and emits runner path/type manifest and immutable inventory",
  async () => {
    const f = await setup();
    const result = await createCodexFixture({
      artifactDir: f.artifact,
      expectedManifestSha256: f.manifestSha,
      entryModulePath: f.entry,
      outputDir: f.output,
      paths: ["/status", "/active-load"],
      id: "codex-smoke",
    });
    const manifest = JSON.parse(
      await NodeFSP.readFile(NodePath.join(f.output, "manifest.json"), "utf8"),
    );
    NodeAssert.deepEqual(manifest, result.manifest);
    NodeAssert.equal(manifest.mainModule, "worker.js");
    NodeAssert.equal(manifest.entrypoint, "ProbeFacet");
    NodeAssert.equal(manifest.mode, "facet");
    NodeAssert.deepEqual(manifest.modules, {
      "worker.js": { path: "worker.js", type: "js" },
      "loader.mjs": { path: "loader.mjs", type: "js" },
      "engine.wasm": { path: "engine.wasm", type: "wasm" },
    });
    // Consume module references in the same path/type form used by the runner.
    for (const module of Object.values(manifest.modules)) {
      const bytes = await NodeFSP.readFile(NodePath.join(f.output, module.path));
      NodeAssert.ok(bytes.byteLength > 0);
      NodeAssert.ok(["js", "wasm"].includes(module.type));
    }
    NodeAssert.deepEqual(
      await NodeFSP.readFile(NodePath.join(f.output, manifest.modules["engine.wasm"].path)),
      f.engine,
    );
    NodeAssert.deepEqual(
      await NodeFSP.readFile(NodePath.join(f.output, manifest.modules["loader.mjs"].path)),
      f.loader,
    );
    NodeAssert.equal(result.inventory.files["engine.wasm"].sha256, hash(f.engine));
    NodeAssert.equal(
      (await NodeFSP.readFile(NodePath.join(f.output, "inventory.json"), "utf8")).includes(
        f.manifestSha,
      ),
      true,
    );
  },
);

NodeTest.test(
  "packages an additional wasm module unchanged with a runner entry and readonly inventory",
  async () => {
    const f = await setup();
    const bash = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
    const bashPath = NodePath.join(f.root, "bash.wasm");
    await NodeFSP.writeFile(bashPath, bash);

    const result = await packageWith(
      f,
      {
        "bash.wasm": {
          path: bashPath,
          type: "wasm",
          bytes: bash.byteLength,
          sha256: hash(bash),
        },
      },
      "codex-bash",
    );

    const manifest = JSON.parse(
      await NodeFSP.readFile(NodePath.join(f.output, "manifest.json"), "utf8"),
    );
    const inventory = JSON.parse(
      await NodeFSP.readFile(NodePath.join(f.output, "inventory.json"), "utf8"),
    );
    NodeAssert.deepEqual(manifest.modules["bash.wasm"], { path: "bash.wasm", type: "wasm" });
    NodeAssert.deepEqual(result.manifest.modules["bash.wasm"], { path: "bash.wasm", type: "wasm" });
    NodeAssert.deepEqual(
      await NodeFSP.readFile(NodePath.join(f.output, manifest.modules["bash.wasm"].path)),
      bash,
    );
    NodeAssert.deepEqual(inventory.files["bash.wasm"], {
      bytes: bash.byteLength,
      sha256: hash(bash),
    });
    NodeAssert.equal(
      (await NodeFSP.stat(NodePath.join(f.output, "bash.wasm"))).mode & 0o777,
      0o444,
    );
  },
);

NodeTest.test(
  "rejects invalid additional wasm files and reserved module names before creating output",
  async () => {
    const bytes = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);

    const badHash = await setup();
    const badHashPath = NodePath.join(badHash.root, "extra.wasm");
    await NodeFSP.writeFile(badHashPath, bytes);
    await NodeAssert.rejects(
      packageWith(badHash, {
        "extra.wasm": {
          path: badHashPath,
          type: "wasm",
          bytes: bytes.byteLength,
          sha256: "0".repeat(64),
        },
      }),
      /does not match declared size and SHA-256/,
    );
    await NodeAssert.rejects(NodeFSP.access(badHash.output), { code: "ENOENT" });

    const badSize = await setup();
    const badSizePath = NodePath.join(badSize.root, "extra.wasm");
    await NodeFSP.writeFile(badSizePath, bytes);
    await NodeAssert.rejects(
      packageWith(badSize, {
        "extra.wasm": {
          path: badSizePath,
          type: "wasm",
          bytes: bytes.byteLength - 1,
          sha256: hash(bytes),
        },
      }),
      /does not match declared size and SHA-256/,
    );
    await NodeAssert.rejects(NodeFSP.access(badSize.output), { code: "ENOENT" });

    const missing = await setup();
    await NodeAssert.rejects(
      packageWith(missing, {
        "extra.wasm": {
          path: NodePath.join(missing.root, "missing.wasm"),
          type: "wasm",
          bytes: bytes.byteLength,
          sha256: hash(bytes),
        },
      }),
      /Missing additional module extra.wasm/,
    );
    await NodeAssert.rejects(NodeFSP.access(missing.output), { code: "ENOENT" });

    const nested = await setup();
    const nestedPath = NodePath.join(nested.root, "extra.wasm");
    await NodeFSP.writeFile(nestedPath, bytes);
    await NodeAssert.rejects(
      packageWith(nested, {
        "nested/extra.wasm": {
          path: nestedPath,
          type: "wasm",
          bytes: bytes.byteLength,
          sha256: hash(bytes),
        },
      }),
      /Additional module name must be flat/,
    );
    await NodeAssert.rejects(NodeFSP.access(nested.output), { code: "ENOENT" });

    const reserved = ["worker.js", "loader.mjs", "engine.wasm", "manifest.json", "inventory.json"];
    for (const name of reserved) {
      const f = await setup();
      const modulePath = NodePath.join(f.root, "extra.wasm");
      await NodeFSP.writeFile(modulePath, bytes);
      await NodeAssert.rejects(
        packageWith(f, {
          [name]: {
            path: modulePath,
            type: "wasm",
            bytes: bytes.byteLength,
            sha256: hash(bytes),
          },
        }),
        new RegExp(`Reserved additional module name: ${name}`),
      );
      await NodeAssert.rejects(NodeFSP.access(f.output), { code: "ENOENT" });
    }

    const linked = await setup();
    const sourcePath = NodePath.join(linked.root, "source.wasm");
    const symlinkPath = NodePath.join(linked.root, "linked.wasm");
    await NodeFSP.writeFile(sourcePath, bytes);
    await NodeFSP.symlink(sourcePath, symlinkPath);
    await NodeAssert.rejects(
      packageWith(linked, {
        "linked.wasm": {
          path: symlinkPath,
          type: "wasm",
          bytes: bytes.byteLength,
          sha256: hash(bytes),
        },
      }),
      /Invalid additional module linked.wasm: expected a regular file/,
    );
    await NodeAssert.rejects(NodeFSP.access(linked.output), { code: "ENOENT" });
  },
);

NodeTest.test(
  "rejects changed artifact bytes and missing files before producing output",
  async () => {
    const f = await setup();
    await NodeFSP.writeFile(NodePath.join(f.artifact, "engine.wasm"), Buffer.from("changed"));
    await NodeAssert.rejects(
      createCodexFixture({
        artifactDir: f.artifact,
        expectedManifestSha256: f.manifestSha,
        entryModulePath: f.entry,
        outputDir: f.output,
        paths: ["/status"],
        id: "bad",
      }),
      /engine.wasm does not match/,
    );
    NodeAssert.equal(
      await NodeFSP.access(f.output).then(
        () => true,
        () => false,
      ),
      false,
    );
    const g = await setup();
    await NodeFSP.rm(NodePath.join(g.artifact, "loader.mjs"));
    await NodeAssert.rejects(
      createCodexFixture({
        artifactDir: g.artifact,
        expectedManifestSha256: g.manifestSha,
        entryModulePath: g.entry,
        outputDir: g.output,
        paths: ["/status"],
        id: "missing",
      }),
      /Missing loader.mjs/,
    );
  },
);

NodeTest.test(
  "rejects manifest mismatch, unsupported target, traversal paths, and input/output overlap",
  async () => {
    const f = await setup();
    await NodeAssert.rejects(
      createCodexFixture({
        artifactDir: f.artifact,
        expectedManifestSha256: "0".repeat(64),
        entryModulePath: f.entry,
        outputDir: f.output,
        paths: ["/status"],
        id: "mismatch",
      }),
      /manifest SHA-256 mismatch/,
    );
    const original = await NodeFSP.readFile(NodePath.join(f.artifact, "manifest.json"), "utf8");
    const changed = JSON.parse(original);
    changed.target = "wasm32-emscripten";
    await NodeFSP.writeFile(NodePath.join(f.artifact, "manifest.json"), JSON.stringify(changed));
    const changedHash = hash(Buffer.from(JSON.stringify(changed)));
    await NodeAssert.rejects(
      createCodexFixture({
        artifactDir: f.artifact,
        expectedManifestSha256: changedHash,
        entryModulePath: f.entry,
        outputDir: NodePath.join(f.root, "out2"),
        paths: ["/status"],
        id: "ems",
      }),
      /Unsupported artifact target/,
    );
    await NodeFSP.writeFile(NodePath.join(f.artifact, "manifest.json"), original);
    await NodeAssert.rejects(
      createCodexFixture({
        artifactDir: f.artifact,
        expectedManifestSha256: f.manifestSha,
        entryModulePath: f.entry,
        outputDir: f.output,
        paths: ["/../escape"],
        id: "traversal",
      }),
      /Invalid probe paths/,
    );
    await NodeAssert.rejects(
      createCodexFixture({
        artifactDir: f.artifact,
        expectedManifestSha256: f.manifestSha,
        entryModulePath: f.entry,
        outputDir: NodePath.join(f.artifact, "out"),
        paths: ["/status"],
        id: "overlap",
      }),
      /overlaps an input/,
    );
  },
);
NodeTest.test("rejects ids that become invalid after the measurement run prefix", async () => {
  for (const id of ["codex_proof", "codex.proof", "a".repeat(84)]) {
    const f = await setup();
    await NodeAssert.rejects(
      createCodexFixture({
        artifactDir: f.artifact,
        expectedManifestSha256: f.manifestSha,
        entryModulePath: f.entry,
        outputDir: f.output,
        paths: ["/startup"],
        id,
      }),
      /Unsafe fixture id/,
    );
  }
});
