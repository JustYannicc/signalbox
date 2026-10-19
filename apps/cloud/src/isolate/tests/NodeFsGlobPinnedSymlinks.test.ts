import { expect, it } from "@effect/vitest";
import { nodeFsGlobOracleFixture } from "./helpers/NodeFsGlobOracleFixture.ts";

it("preserves Node 24.18 Dirent traversal through symlinks and cycles", async () => {
  const fixture = await nodeFsGlobOracleFixture();
  try {
    const rows = [];
    for await (const entry of fixture.promises.glob("**/*", {
      cwd: "/work",
      withFileTypes: true,
      exclude: (entry) => {
        if (typeof entry === "string") throw new Error("Expected a Dirent exclusion value");
        return entry.name === "node_modules";
      },
    })) {
      if (typeof entry === "string") throw new Error("Expected a Dirent");
      const parent = entry.parentPath === "/work" ? "" : `${entry.parentPath.slice(6)}/`;
      const kind = entry.isFile()
        ? "file"
        : entry.isDirectory()
          ? "directory"
          : entry.isSymbolicLink()
            ? "symlink"
            : "other";
      rows.push(`${parent}${entry.name}:${kind}`);
    }

    // Captured from Node 24.18.0, the vendored walker version. Later hosts differ.
    expect(rows.toSorted()).toEqual([
      "alias/nested:directory",
      "alias:symlink",
      "docs/nested/guide.md:file",
      "docs/nested:directory",
      "docs/readme.md:file",
      "docs:directory",
      "empty:directory",
      "lazy:directory",
      "real/nested/cycle/alias:symlink",
      "real/nested/cycle/docs:directory",
      "real/nested/cycle/empty:directory",
      "real/nested/cycle/lazy:directory",
      "real/nested/cycle/node_modules:directory",
      "real/nested/cycle/real:directory",
      "real/nested/cycle/src:directory",
      "real/nested/cycle:symlink",
      "real/nested/file.ts:file",
      "real/nested:directory",
      "real:directory",
      "src/a.js:file",
      "src/a.test.js:file",
      "src/b.ts:file",
      "src/deep/c.js:file",
      "src/deep:directory",
      "src:directory",
    ]);
  } finally {
    await fixture.close();
  }
});
