// @effect-diagnostics nodeBuiltinImport:off - inspect generated files in temporary test directories.
import { describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { publishBundle, type BundlePublication } from "./bundle-artifact.ts";

const bytes = (source: string) => new TextEncoder().encode(source);
const digest = (source: Uint8Array | string) =>
  NodeCrypto.createHash("sha256").update(source).digest("hex");

function input(output: string): BundlePublication {
  return {
    output,
    release: {
      provider: "claude-code",
      version: "2.1.302",
      platform: "linux-x64",
      binarySha256: "a".repeat(64),
    },
    mainModule: "claude.js",
    modules: [
      { path: "claude.js", contents: bytes('export {run} from "./chunks/run.js";') },
      { path: "chunks/run.js", contents: bytes("export const run=()=>42;") },
    ],
    assets: [
      {
        name: "/$bunfs/root/embedded.wasm",
        key: "$bunfs/root/embedded.wasm",
        path: "assets/wasm",
        contents: new Uint8Array([0, 97, 115, 109]),
        loader: 5,
        encoding: 0,
      },
    ],
    requiredHostModules: ["bun:jsc"],
    sourceModules: ["$bunfs/root/cli"],
    metafile: {},
  };
}

describe("immutable rebundle artifacts", () => {
  it("binds all modules and embedded assets to the artifact hash and emits a loader map", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "claude-artifact-"));
    try {
      const candidate = input(NodePath.join(root, "first"));
      const first = await publishBundle(candidate);
      const manifest = await NodeFSP.readFile(
        NodePath.join(candidate.output, "manifest.json"),
        "utf8",
      );
      expect(first.artifactSha256).toBe(digest(manifest));
      expect(
        JSON.parse(
          await NodeFSP.readFile(NodePath.join(candidate.output, "module-map.json"), "utf8"),
        ),
      ).toEqual({
        "chunks/run.js": { path: "chunks/run.js", type: "js" },
        "claude.js": { path: "claude.js", type: "js" },
      });
      expect(first.manifest.assets["/$bunfs/root/embedded.wasm"]?.sha256).toBe(
        digest(new Uint8Array([0, 97, 115, 109])),
      );
      const second = await publishBundle({ ...candidate, output: NodePath.join(root, "second") });
      expect(second.artifactSha256).toBe(first.artifactSha256);
      const changed = await publishBundle({
        ...candidate,
        output: NodePath.join(root, "third"),
        modules: [
          candidate.modules[0]!,
          { path: "chunks/run.js", contents: bytes("export const run=()=>43;") },
        ],
      });
      expect(changed.artifactSha256).not.toBe(first.artifactSha256);
      await expect(publishBundle(candidate)).rejects.toThrow("BUNDLE_OUTPUT_EXISTS");
      expect(await NodeFSP.readFile(NodePath.join(candidate.output, "manifest.json"), "utf8")).toBe(
        manifest,
      );
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("removes failed staging directories and refuses escaping or duplicate paths", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "claude-artifact-"));
    try {
      const candidate = input(NodePath.join(root, "out"));
      for (const path of ["../outside.js", "/absolute.js", "chunks/../main.js", "manifest.json"])
        await expect(
          publishBundle({ ...candidate, modules: [{ path, contents: bytes("throw 1;") }] }),
        ).rejects.toThrow(/BUNDLE_PATH_(INVALID|DUPLICATE)/);
      await expect(
        publishBundle({ ...candidate, modules: [candidate.modules[0]!, candidate.modules[0]!] }),
      ).rejects.toThrow("BUNDLE_PATH_DUPLICATE");
      expect(await NodeFSP.readdir(root)).toEqual([]);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
