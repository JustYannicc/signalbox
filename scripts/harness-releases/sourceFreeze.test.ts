import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { assertSourcesUnchanged, freezeSources, readSourceFreeze } from "./sourceFreeze.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => NodeFSP.rm(path, { recursive: true, force: true })),
  );
});

async function repository() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "1072-source-freeze-"));
  directories.push(root);
  const git = (args: string[]) => NodeChildProcess.execFileSync("git", args, { cwd: root });
  git(["init", "--quiet"]);
  await NodeFSP.mkdir(NodePath.join(root, "scripts/claude-bunfs"), { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(root, "scripts/claude-bunfs/build.ts"),
    "export const build = 1;\n",
  );
  await NodeFSP.writeFile(NodePath.join(root, ".gitignore"), "output/\n");
  git(["add", "."]);
  git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@invalid",
    "commit",
    "--quiet",
    "--no-gpg-sign",
    "-m",
    "fixture",
  ]);
  return root;
}

describe("release source freeze", () => {
  it("keeps ignored build output separate from the frozen layer", async () => {
    const root = await repository();
    const before = await freezeSources(root);
    expect(readSourceFreeze(JSON.parse(JSON.stringify(before)))).toEqual(before);
    expect(() => readSourceFreeze({ ...before, sha256: "0".repeat(64) })).toThrow(
      "RELEASE_SOURCE_FREEZE_INVALID",
    );
    await NodeFSP.mkdir(NodePath.join(root, "output"));
    await NodeFSP.writeFile(NodePath.join(root, "output/artifact.json"), "new release");
    expect(() => assertSourcesUnchanged(before, before)).not.toThrow();
    expect(await freezeSources(root)).toEqual(before);
    expect(before.files.map((file) => file.path)).toEqual(["scripts/claude-bunfs/build.ts"]);
  });

  it("rejects an uncommitted per-release edit and a new untracked compatibility file", async () => {
    const root = await repository();
    const before = await freezeSources(root);
    const build = NodePath.join(root, "scripts/claude-bunfs/build.ts");
    const original = await NodeFSP.readFile(build);
    await NodeFSP.writeFile(build, "export const build = 2;\n");
    const modified = await freezeSources(root);
    expect(modified.commit).toBe(before.commit);
    expect(() => assertSourcesUnchanged(before, modified)).toThrow("RELEASE_SOURCE_CHANGED");
    await NodeFSP.writeFile(build, original);
    await NodeFSP.writeFile(
      NodePath.join(root, "scripts/claude-bunfs/release-fix.ts"),
      "workaround",
    );
    const added = await freezeSources(root);
    expect(added.files).toHaveLength(2);
    expect(() => assertSourcesUnchanged(before, added)).toThrow("RELEASE_SOURCE_CHANGED");
  });

  it("fails when a tracked input disappears or becomes an external symlink", async () => {
    const root = await repository();
    const build = NodePath.join(root, "scripts/claude-bunfs/build.ts");
    await NodeFSP.unlink(build);
    await expect(freezeSources(root)).rejects.toThrow();
    await NodeFSP.symlink("../../outside.ts", build);
    await expect(freezeSources(root)).rejects.toThrow("RELEASE_SOURCE_NOT_REGULAR");
  });
});
