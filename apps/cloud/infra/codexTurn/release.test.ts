// @effect-diagnostics nodeBuiltinImport:off - verifies native artifact input failures.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import { fetchCodexRelease } from "./release.ts";

it.each([
  ["missing", () => new Response(null, { status: 404 }), "CODEX_RELEASE_DOWNLOAD_FAILED:"],
  ["mismatched", () => new Response("stale artifact"), "CODEX_RELEASE_INPUT_MISMATCH:"],
] as const)(
  "rejects a %s release without creating a usable input directory",
  async (_name, response, expected) => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "codex-release-"));
    const output = NodePath.join(root, "release");
    try {
      await expect(fetchCodexRelease(output, { fetch: async () => response() })).rejects.toThrow(
        expected,
      );
      await expect(NodeFSP.stat(output)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  },
);
