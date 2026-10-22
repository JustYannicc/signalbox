// @effect-diagnostics nodeBuiltinImport:off - builds an isolated workspace fixture.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import { PREVIEW_FILE_MAX_BYTES } from "@t3tools/shared/previewFiles";

import { makeRunnerPreviewFiles } from "./RunnerPreviewFiles.ts";

describe("RunnerPreviewFiles", () => {
  it.effect("serves workspace files, resolves directories, and supports HEAD", () =>
    Effect.flatMap(HostProcess.Platform, (platform) =>
      Effect.promise(async () => {
        const workspace = await NodeFSP.mkdtemp(
          NodePath.join(NodeOS.tmpdir(), "signalbox-preview-files-"),
        );
        try {
          await NodeFSP.mkdir(NodePath.join(workspace, "assets"));
          await NodeFSP.writeFile(NodePath.join(workspace, "index.html"), "<main>home</main>");
          await NodeFSP.writeFile(
            NodePath.join(workspace, "assets", "index.html"),
            "<main>assets</main>",
          );
          await NodeFSP.writeFile(
            NodePath.join(workspace, "assets", "app.css"),
            "body { color: red; }",
          );
          const files = makeRunnerPreviewFiles(workspace, platform);

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
          await NodeFSP.rm(workspace, { recursive: true, force: true });
        }
      }),
    ),
  );

  it.effect("hides unsafe paths and symlinks and bounds file size", () =>
    Effect.flatMap(HostProcess.Platform, (platform) =>
      Effect.promise(async () => {
        const workspace = await NodeFSP.mkdtemp(
          NodePath.join(NodeOS.tmpdir(), "signalbox-preview-files-"),
        );
        const outside = await NodeFSP.mkdtemp(
          NodePath.join(NodeOS.tmpdir(), "signalbox-preview-outside-"),
        );
        try {
          await NodeFSP.writeFile(NodePath.join(workspace, "small.txt"), "safe");
          await NodeFSP.writeFile(NodePath.join(outside, "secret.txt"), "private");
          await NodeFSP.symlink(
            NodePath.join(outside, "secret.txt"),
            NodePath.join(workspace, "secret.txt"),
          );
          await NodeFSP.writeFile(
            NodePath.join(workspace, "large.bin"),
            new Uint8Array(PREVIEW_FILE_MAX_BYTES + 1),
          );
          const files = makeRunnerPreviewFiles(workspace, platform);

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
          await NodeFSP.rm(workspace, { recursive: true, force: true });
          await NodeFSP.rm(outside, { recursive: true, force: true });
        }
      }),
    ),
  );
});
