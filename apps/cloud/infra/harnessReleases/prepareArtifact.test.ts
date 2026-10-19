import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { openHarnessReleaseArtifact } from "../../src/harnessReleases/HarnessReleaseArtifact.ts";
import { artifactDirectorySource, prepareHarnessArtifact } from "./prepareArtifact.ts";
import {
  prepareHarnessArtifactWithFileSystem,
  type ArtifactFileSystem,
} from "./prepareArtifact.internal.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});
const setup = async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "1072-artifact-prepare-"));
  roots.push(root);
  const cli = NodePath.join(root, "cli");
  const sdk = NodePath.join(root, "sdk");
  await NodeFSP.mkdir(NodePath.join(cli, "chunks"), { recursive: true });
  await NodeFSP.mkdir(sdk);
  const manifest = '{ "schemaVersion": 1, "mainModule": "entry.js" }\n';
  await NodeFSP.writeFile(NodePath.join(cli, "manifest.json"), manifest);
  await NodeFSP.writeFile(NodePath.join(cli, "chunks/%2F%24bunfs.js"), "export const cli=1;");
  await NodeFSP.writeFile(NodePath.join(sdk, "manifest.json"), '{"mainModule":"sdk.js"}');
  await NodeFSP.writeFile(NodePath.join(sdk, "sdk.js"), "export const sdk=1;");
  return {
    root,
    cli,
    sdk,
    manifest,
    input: {
      harness: "claude-code" as const,
      sourceIdentity: "a".repeat(64),
      computer: { sourceIdentity: "b".repeat(64), manifestSha256: "c".repeat(64) },
      components: { cli, sdk },
      output: NodePath.join(root, "output"),
    },
  };
};

const withFileSystem = (
  overrides: Partial<Record<keyof ArtifactFileSystem, unknown>>,
): ArtifactFileSystem =>
  ({
    mkdir: overrides.mkdir ?? NodeFSP.mkdir,
    realpath: overrides.realpath ?? NodeFSP.realpath,
    readdir: overrides.readdir ?? NodeFSP.readdir,
    lstat: overrides.lstat ?? NodeFSP.lstat,
    open: overrides.open ?? NodeFSP.open,
    mkdtemp: overrides.mkdtemp ?? NodeFSP.mkdtemp,
    symlink: overrides.symlink ?? NodeFSP.symlink,
    unlink: overrides.unlink ?? NodeFSP.unlink,
    rmdir: overrides.rmdir ?? NodeFSP.rmdir,
  }) as ArtifactFileSystem;

describe("Harness artifact preparation", () => {
  it("preserves raw provider bytes and binds both components in one identity", async () => {
    const { root, sdk, manifest, input } = await setup();
    const identity = await prepareHarnessArtifact(input);
    const outputIdentity = await NodeFSP.lstat(input.output);
    const outputDirectory = await NodeFSP.stat(input.output);
    expect(outputDirectory.isDirectory()).toBe(true);
    if (NodePath.sep === "/") expect(outputDirectory.mode & 0o777).toBe(0o700);
    const stagingPath = await NodeFSP.realpath(input.output);
    const envelope = await NodeFSP.readFile(NodePath.join(input.output, "manifest.json"), "utf8");
    expect(envelope).not.toContain(stagingPath);
    const outputManifest = await NodeFSP.readFile(
      NodePath.join(input.output, "cli", "manifest.json"),
    );
    const artifact = await openHarnessReleaseArtifact(
      identity,
      artifactDirectorySource(input.output),
    );
    expect(new TextDecoder().decode(await artifact.read("cli/manifest.json"))).toBe(manifest);
    expect(new TextDecoder().decode(await artifact.read("cli/chunks/%2F%24bunfs.js"))).toBe(
      "export const cli=1;",
    );
    expect(artifact.rawManifests.sdk?.mainModule).toBe("sdk.js");
    await NodeFSP.writeFile(NodePath.join(sdk, "sdk.js"), "export const sdk=2;");
    const changed = await prepareHarnessArtifact({
      ...input,
      output: NodePath.join(root, "changed"),
    });
    expect(changed.artifactHash).not.toBe(identity.artifactHash);
    await expect(prepareHarnessArtifact(input)).rejects.toThrow("HARNESS_ARTIFACT_OUTPUT_EXISTS");
    const outputAfterRepeat = await NodeFSP.lstat(input.output);
    expect(outputAfterRepeat.dev).toBe(outputIdentity.dev);
    expect(outputAfterRepeat.ino).toBe(outputIdentity.ino);
    expect(await NodeFSP.readFile(NodePath.join(input.output, "cli", "manifest.json"))).toEqual(
      outputManifest,
    );
    expect(new TextDecoder().decode(await artifact.read("sdk/sdk.js"))).toBe("export const sdk=1;");
  });

  it("rejects a pre-existing public destination without changing it", async () => {
    const { root, input } = await setup();
    const marker = NodePath.join(input.output, "owner.txt");
    await NodeFSP.mkdir(input.output);
    await NodeFSP.writeFile(marker, "keep this directory");
    const original = await NodeFSP.lstat(input.output);

    await expect(prepareHarnessArtifact(input)).rejects.toThrow("HARNESS_ARTIFACT_OUTPUT_EXISTS");
    const current = await NodeFSP.lstat(input.output);
    expect(current.dev).toBe(original.dev);
    expect(current.ino).toBe(original.ino);
    expect(await NodeFSP.readFile(marker, "utf8")).toBe("keep this directory");
    expect(await NodeFSP.readdir(root)).toContain("output");
  });

  it("refuses incomplete pairs and escaping symlinks without publishing a manifest", async () => {
    const { root, cli, input } = await setup();
    await expect(prepareHarnessArtifact({ ...input, components: { cli } })).rejects.toThrow(
      "HARNESS_ARTIFACT_COMPONENTS_INVALID",
    );
    await NodeFSP.symlink(NodePath.join(root, "sdk/sdk.js"), NodePath.join(cli, "external.js"));
    await expect(prepareHarnessArtifact(input)).rejects.toThrow("HARNESS_ARTIFACT_SYMLINK");
    await expect(NodeFSP.lstat(input.output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses an output inside a component before recursively copying it", async () => {
    const { cli, input } = await setup();
    await expect(
      prepareHarnessArtifact({ ...input, output: NodePath.join(cli, "output") }),
    ).rejects.toThrow("HARNESS_ARTIFACT_OUTPUT_INSIDE_INPUT");
  });

  it("rejects a listed child directory replaced by an external symlink before publication", async () => {
    const { root, cli, input } = await setup();
    const chunks = NodePath.join(cli, "chunks");
    const movedChunks = NodePath.join(cli, "chunks-original");
    const canonicalCli = await NodeFSP.realpath(cli);
    const external = NodePath.join(root, "external");
    await NodeFSP.mkdir(external);
    await NodeFSP.writeFile(NodePath.join(external, "outside.js"), "external bytes");
    let replaced = false;
    const readdir = async (path: string) => {
      const entries = await NodeFSP.readdir(path, { withFileTypes: true });
      if (path === canonicalCli && !replaced) {
        replaced = true;
        await NodeFSP.rename(chunks, movedChunks);
        await NodeFSP.symlink(external, chunks, "dir");
      }
      return entries;
    };

    await expect(
      prepareHarnessArtifactWithFileSystem(input, withFileSystem({ readdir })),
    ).rejects.toThrow("HARNESS_ARTIFACT_SYMLINK");
    expect(replaced).toBe(true);
    await expect(NodeFSP.lstat(input.output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a source file replaced after its identity check", async () => {
    const { root, sdk, input } = await setup();
    const sourceFile = NodePath.join(sdk, "sdk.js");
    const movedSourceFile = NodePath.join(sdk, "sdk-original.js");
    const canonicalSourceFile = NodePath.join(await NodeFSP.realpath(sdk), "sdk.js");
    const externalFile = NodePath.join(root, "external.js");
    await NodeFSP.writeFile(externalFile, "external bytes");
    let replaced = false;
    const open: ArtifactFileSystem["open"] = async (path, flags, mode) => {
      if (path === canonicalSourceFile && flags === "r" && !replaced) {
        replaced = true;
        await NodeFSP.rename(sourceFile, movedSourceFile);
        await NodeFSP.symlink(externalFile, sourceFile);
      }
      return NodeFSP.open(path, flags, mode);
    };

    await expect(
      prepareHarnessArtifactWithFileSystem(input, withFileSystem({ open })),
    ).rejects.toThrow("HARNESS_ARTIFACT_FILE_CHANGED");
    expect(replaced).toBe(true);
    await expect(NodeFSP.lstat(input.output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a foreign output replacement and its contents when raw manifest validation fails", async () => {
    const { root, cli, input } = await setup();
    const output = NodePath.join(await NodeFSP.realpath(root), "output");
    const marker = NodePath.join(output, "foreign.txt");
    await NodeFSP.writeFile(NodePath.join(cli, "manifest.json"), "[]");
    let replacement: { dev: number; ino: number } | undefined;
    let replaced = false;
    let injected = false;
    let stagingPath: string | undefined;
    const mkdir: ArtifactFileSystem["mkdir"] = async (path, options) => {
      if (options) await NodeFSP.mkdir(path, options);
      else await NodeFSP.mkdir(path);
      if (path === output && !replaced) {
        replaced = true;
        await NodeFSP.rename(output, NodePath.join(root, "moved-claim"));
        await NodeFSP.mkdir(output);
        const stat = await NodeFSP.lstat(output);
        replacement = { dev: stat.dev, ino: stat.ino };
      }
    };
    const open: ArtifactFileSystem["open"] = async (path, flags, mode) => {
      const handle = await NodeFSP.open(path, flags, mode);
      const pathString = path.toString();
      const parent = NodePath.dirname(pathString);
      const isEnvelopeManifest =
        flags === "wx" &&
        NodePath.basename(pathString) === "manifest.json" &&
        (parent === output || NodePath.basename(parent).startsWith(".harness-artifact-stage-"));
      if (!isEnvelopeManifest) return handle;
      if (parent !== output) stagingPath = parent;
      return {
        stat: () => handle.stat(),
        readFile: () => handle.readFile(),
        writeFile: async (bytes) => {
          if (!injected) {
            if (!replaced) {
              await NodeFSP.mkdir(output);
              const stat = await NodeFSP.lstat(output);
              replacement = { dev: stat.dev, ino: stat.ino };
              replaced = true;
              const foreignManifest = NodePath.join(output, "cli", "manifest.json");
              await NodeFSP.mkdir(NodePath.dirname(foreignManifest), { recursive: true });
              await NodeFSP.writeFile(foreignManifest, "[]");
            }
            await NodeFSP.writeFile(marker, "foreign output contents");
            injected = true;
          }
          await handle.writeFile(bytes);
        },
        close: () => handle.close(),
      } as Awaited<ReturnType<typeof NodeFSP.open>>;
    };

    await expect(
      prepareHarnessArtifactWithFileSystem(input, withFileSystem({ mkdir, open })),
    ).rejects.toThrow("RAW_MANIFEST_NOT_OBJECT");
    expect(replaced).toBe(true);
    expect(injected).toBe(true);
    const current = await NodeFSP.lstat(output);
    if (!replacement) throw new Error("Missing foreign replacement identity");
    expect(current.dev).toBe(replacement.dev);
    expect(current.ino).toBe(replacement.ino);
    expect(await NodeFSP.readFile(marker, "utf8")).toBe("foreign output contents");
    expect(await NodeFSP.readFile(NodePath.join(output, "cli", "manifest.json"), "utf8")).toBe(
      "[]",
    );
    if (stagingPath) {
      await expect(NodeFSP.lstat(stagingPath)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("leaves a destination created concurrently with atomic publication untouched", async () => {
    const { root, input } = await setup();
    const output = NodePath.join(await NodeFSP.realpath(root), "output");
    const marker = NodePath.join(output, "other-owner.txt");
    let concurrentIdentity: { dev: number; ino: number } | undefined;
    let createdConcurrently = false;
    const symlink: ArtifactFileSystem["symlink"] = async (target, path, type) => {
      if (path === output && !createdConcurrently) {
        createdConcurrently = true;
        await NodeFSP.mkdir(output);
        await NodeFSP.writeFile(marker, "keep this directory");
        const stat = await NodeFSP.lstat(output);
        concurrentIdentity = { dev: stat.dev, ino: stat.ino };
      }
      await NodeFSP.symlink(target, path, type);
    };

    await expect(
      prepareHarnessArtifactWithFileSystem(input, withFileSystem({ symlink })),
    ).rejects.toThrow("HARNESS_ARTIFACT_OUTPUT_EXISTS");
    expect(createdConcurrently).toBe(true);
    const current = await NodeFSP.lstat(output);
    if (!concurrentIdentity) throw new Error("Missing concurrent destination identity");
    expect(current.dev).toBe(concurrentIdentity.dev);
    expect(current.ino).toBe(concurrentIdentity.ino);
    expect(await NodeFSP.readFile(marker, "utf8")).toBe("keep this directory");
    expect(await NodeFSP.readdir(root)).toContain("output");
  });

  it("keeps the envelope unavailable while payloads are being written", async () => {
    const { input } = await setup();
    let checked = false;
    const open: ArtifactFileSystem["open"] = async (path, flags, mode) => {
      const handle = await NodeFSP.open(path, flags, mode);
      if (!path.toString().endsWith(NodePath.join("cli", "manifest.json")) || flags !== "wx")
        return handle;
      return {
        stat: () => handle.stat(),
        readFile: () => handle.readFile(),
        writeFile: async (bytes) => {
          await handle.writeFile(bytes);
          checked = true;
          await expect(
            artifactDirectorySource(input.output).read("", "manifest.json"),
          ).rejects.toMatchObject({ code: "ENOENT" });
        },
        close: () => handle.close(),
      } as Awaited<ReturnType<typeof NodeFSP.open>>;
    };

    await prepareHarnessArtifactWithFileSystem(input, withFileSystem({ open }));
    expect(checked).toBe(true);
  });
});
