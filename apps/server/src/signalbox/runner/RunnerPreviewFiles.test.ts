// @effect-diagnostics nodeBuiltinImport:off - builds an isolated workspace fixture.
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { PREVIEW_FILE_MAX_BYTES } from "@t3tools/shared/previewFiles";

import { makeRunnerPreviewFiles } from "./RunnerPreviewFiles.ts";

describe("RunnerPreviewFiles", () => {
  it("serves workspace files, resolves directories, and supports HEAD", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "signalbox-preview-files-"));
    try {
      await mkdir(join(workspace, "assets"));
      await writeFile(join(workspace, "index.html"), "<main>home</main>");
      await writeFile(join(workspace, "assets", "index.html"), "<main>assets</main>");
      await writeFile(join(workspace, "assets", "app.css"), "body { color: red; }");
      const files = makeRunnerPreviewFiles(workspace);

      const root = await files.read("GET", "/");
      expect(root.status).toBe(200);
      expect(root.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(new TextDecoder().decode(root.body!)).toBe("<main>home</main>");

      const redirect = await files.read("GET", "/assets?mode=dark");
      expect(redirect).toMatchObject({
        status: 308,
        headers: { location: "/assets/?mode=dark" },
        body: null,
      });
      const directory = await files.read("GET", "/assets/");
      expect(new TextDecoder().decode(directory.body!)).toBe("<main>assets</main>");

      const head = await files.read("HEAD", "/assets/app.css");
      expect(head).toMatchObject({
        status: 200,
        headers: {
          "content-type": "text/css; charset=utf-8",
          "content-length": String(Buffer.byteLength("body { color: red; }")),
        },
        body: null,
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("hides unsafe paths and symlinks and bounds file size", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "signalbox-preview-files-"));
    const outside = await mkdtemp(join(tmpdir(), "signalbox-preview-outside-"));
    try {
      await writeFile(join(workspace, "small.txt"), "safe");
      await writeFile(join(outside, "secret.txt"), "private");
      await symlink(join(outside, "secret.txt"), join(workspace, "secret.txt"));
      await writeFile(join(workspace, "large.bin"), new Uint8Array(PREVIEW_FILE_MAX_BYTES + 1));
      const files = makeRunnerPreviewFiles(workspace);

      for (const path of ["/../secret.txt", "/%2e%2e/secret.txt", "/.hidden", "/secret.txt"]) {
        const response = await files.read("GET", path);
        expect(response.status, path).toBe(404);
        expect(new TextDecoder().decode(response.body!)).not.toContain("private");
      }
      expect((await files.read("GET", "/large.bin")).status).toBe(413);
      expect(await files.read("POST", "/small.txt")).toMatchObject({
        status: 405,
        headers: { allow: "GET, HEAD" },
      });
      expect((await files.read("HEAD", "/missing.txt")).body).toBe(null);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
