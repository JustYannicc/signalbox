// @effect-diagnostics nodeBuiltinImport:off - exercises the fixture writer through its CLI.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { expect, it } from "vite-plus/test";
import { selectedVersions } from "./releases.ts";

const root = NodeURL.fileURLToPath(new URL("../../", import.meta.url));
const prepareFixture = NodeURL.fileURLToPath(new URL("./prepare-fixture.ts", import.meta.url));

it.each(["", "latest"] as const)(
  "keeps %s selection in the built facet paths",
  async (selection) => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bun-fixture-test-"));
    const latest = "2.1.309";
    const versions = selectedVersions(selection, latest);
    const output = NodePath.join(directory, "fixture");
    try {
      const result = NodeChildProcess.spawnSync(
        process.execPath,
        ["--experimental-strip-types", prepareFixture, output, versions.join(",")],
        { cwd: root, encoding: "utf8" },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      const manifest = JSON.parse(
        await NodeFSP.readFile(NodePath.join(output, "manifest.json"), "utf8"),
      );

      expect(manifest.paths).toEqual(
        versions.map((version) => `/proof?version=${version}&platform=linux-x64`),
      );
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  },
);
