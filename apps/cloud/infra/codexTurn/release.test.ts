// @effect-diagnostics nodeBuiltinImport:off - verifies native artifact input failures.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it, vi } from "vite-plus/test";
import { CODEX_WASI_RELEASE, fetchCodexRelease } from "./release.ts";

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

it("rejects API fallback bytes before creating the fresh release directory", async () => {
  vi.useFakeTimers();
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "codex-release-"));
  const output = NodePath.join(root, "release");
  const assets = Object.keys(CODEX_WASI_RELEASE.files).map((name, index) => ({
    name,
    url: `https://api.github.com/repos/JustYannicc/signalbox/releases/assets/${index}`,
  }));
  const fetcher: typeof fetch = async (url) => {
    if (String(url).startsWith(CODEX_WASI_RELEASE.url)) return new Response(null, { status: 504 });
    if (String(url).includes("/releases/tags/")) return Response.json({ assets });
    return new Response("unverified fallback");
  };
  try {
    const result = expect(fetchCodexRelease(output, { fetch: fetcher })).rejects.toThrow(
      "CODEX_RELEASE_INPUT_MISMATCH:",
    );
    await vi.runAllTimersAsync();
    await result;
    await expect(NodeFSP.stat(output)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    vi.useRealTimers();
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
