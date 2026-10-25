// @effect-diagnostics nodeBuiltinImport:off - Native Node is used only as a disposable behavior oracle.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { createNodeFs } from "../../NodeFs.ts";
import { nodeFsPosixFixture } from "./NodeFsPosixFixture.ts";

const directories = [
  "src/deep",
  "docs/nested",
  "node_modules/pkg",
  "real/nested",
  ".hidden-dir/nested",
  "lazy",
  "empty",
];

const files = {
  "src/a.js": "a",
  "src/b.ts": "b",
  "src/deep/c.js": "c",
  "src/.hidden.js": "hidden",
  "src/a.test.js": "test",
  "docs/readme.md": "readme",
  "docs/nested/guide.md": "guide",
  "node_modules/pkg/index.js": "package",
  ".hidden-dir/inside.js": "hidden directory",
  ".root-hidden": "hidden root file",
  "real/nested/file.ts": "real file",
};

export async function nodeFsGlobOracleFixture({ symlinks = true } = {}) {
  const fixture = nodeFsPosixFixture();
  const promises = createNodeFs(fixture.kernelFs)["fs/promises"];
  const nativeRoot = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "signalbox-glob-oracle-"),
  );

  try {
    await promises.mkdir("/work", { recursive: true });
    for (const directory of directories) {
      await promises.mkdir(`/work/${directory}`, { recursive: true });
      await NodeFSP.mkdir(NodePath.join(nativeRoot, directory), { recursive: true });
    }
    for (const [path, contents] of Object.entries(files)) {
      await promises.writeFile(`/work/${path}`, contents);
      await NodeFSP.writeFile(NodePath.join(nativeRoot, path), contents);
    }
    if (symlinks) {
      await promises.symlink("/work/real", "/work/alias");
      await promises.symlink("/work", "/work/real/nested/cycle");
      await NodeFSP.symlink(NodePath.join(nativeRoot, "real"), NodePath.join(nativeRoot, "alias"));
      await NodeFSP.symlink(nativeRoot, NodePath.join(nativeRoot, "real/nested/cycle"));
    }

    return {
      kernelFs: fixture.kernelFs,
      nativeRoot,
      promises,
      async close() {
        try {
          fixture.close();
        } finally {
          await NodeFSP.rm(nativeRoot, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    try {
      fixture.close();
    } finally {
      await NodeFSP.rm(nativeRoot, { recursive: true, force: true });
    }
    throw error;
  }
}
