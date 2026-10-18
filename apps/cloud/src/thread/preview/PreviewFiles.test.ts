import { PREVIEW_FILE_MAX_BYTES } from "@t3tools/shared/previewFiles";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { DriveReader } from "../../drive/DriveReader.ts";
import { makePreviewFiles, type PreviewFileReader } from "./PreviewFiles.ts";

type Entry = Exclude<Effect.Success<ReturnType<DriveReader["entryAt"]>>, null>;

const entry = (name: string, kind: Entry["kind"], oid: string): Entry => ({
  name,
  mode:
    kind === "directory"
      ? "40000"
      : kind === "executable"
        ? "100755"
        : kind === "symlink"
          ? "120000"
          : kind === "submodule"
            ? "160000"
            : "100644",
  kind,
  oid,
});

const file = (path: string, contents: string, oid: string) => ({
  path,
  entry: entry(path.split("/").at(-1)!, "file", oid),
  bytes: new TextEncoder().encode(contents),
});

const fixture = (options: {
  readonly files: ReadonlyArray<ReturnType<typeof file>>;
  readonly entries?: ReadonlyArray<readonly [string, Entry]>;
  readonly presentRefs?: ReadonlyArray<string>;
}) => {
  const entries = new Map<string, Entry>([["", entry("", "directory", "tree")]]);
  const blobs = new Map<string, Uint8Array<ArrayBuffer>>();
  for (const [path, item] of options.entries ?? []) entries.set(path, item);
  for (const item of options.files) {
    entries.set(item.path, item.entry);
    blobs.set(item.entry.oid, item.bytes);
  }

  const blobReads: Array<string> = [];
  const reader: PreviewFileReader = {
    drive: {
      ref: (name) => Effect.succeed(options.presentRefs?.includes(name) ? "commit" : null),
    },
    treeOf: () => Effect.succeed("tree"),
    entryAt: (_tree, segments) => Effect.succeed(entries.get(segments.join("/")) ?? null),
    sizes: (oids) =>
      Effect.succeed(
        new Map(oids.map((oid) => [oid, blobs.get(oid)?.byteLength ?? null] as const)),
      ),
    blob: (oid) =>
      Effect.sync(() => {
        blobReads.push(oid);
        return blobs.get(oid) ?? new Uint8Array();
      }),
  };

  return {
    serve: makePreviewFiles(reader, ["wip/thread", "threads/thread", "main"]),
    blobReads,
  };
};

const textFile = (path: string, contents: string) => file(path, contents, `oid:${path}`);

describe("thread preview files", () => {
  it.effect("serves saved files, directory indexes, and HEAD through the first available ref", () =>
    Effect.gen(function* () {
      const { serve } = fixture({
        presentRefs: ["threads/thread"],
        files: [
          textFile("index.html", "<h1>saved preview</h1>"),
          textFile("assets/index.html", "<p>asset index</p>"),
          textFile("assets/site.css", "body { color: red; }"),
          {
            ...file("assets/pixel.png", "", "oid:assets/pixel.png"),
            bytes: new Uint8Array([137, 80, 78, 71]),
          },
          textFile(".secret", "hidden"),
        ],
        entries: [["assets", entry("assets", "directory", "assets-tree")]],
      });

      const home = yield* serve(new Request("https://preview.test/"));
      expect(home.status).toBe(200);
      expect(yield* Effect.promise(() => home.text())).toBe("<h1>saved preview</h1>");
      expect(home.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(home.headers.get("cache-control")).toBe("no-store");
      expect(home.headers.get("x-content-type-options")).toBe("nosniff");

      const directory = yield* serve(new Request("https://preview.test/assets?mode=full"));
      expect(directory.status).toBe(308);
      expect(directory.headers.get("location")).toBe("https://preview.test/assets/?mode=full");

      const assetIndex = yield* serve(new Request("https://preview.test/assets/"));
      expect(yield* Effect.promise(() => assetIndex.text())).toBe("<p>asset index</p>");

      const asset = yield* serve(new Request("https://preview.test/assets/site.css"));
      expect(yield* Effect.promise(() => asset.text())).toBe("body { color: red; }");
      expect(asset.headers.get("content-type")).toBe("text/css; charset=utf-8");

      const image = yield* serve(new Request("https://preview.test/assets/pixel.png"));
      expect(image.headers.get("content-type")).toBe("image/png");
      expect(Array.from(new Uint8Array(yield* Effect.promise(() => image.arrayBuffer())))).toEqual([
        137, 80, 78, 71,
      ]);

      const head = yield* serve(new Request("https://preview.test/", { method: "HEAD" }));
      expect(head.status).toBe(200);
      expect(head.body).toBeNull();
      expect(head.headers.get("content-length")).toBe(String("<h1>saved preview</h1>".length));

      expect((yield* serve(new Request("https://preview.test/.secret"))).status).toBe(404);
      expect((yield* serve(new Request("https://preview.test/%252e%252e/index.html"))).status).toBe(
        404,
      );
      const method = yield* serve(new Request("https://preview.test/", { method: "POST" }));
      expect(method.status).toBe(405);
      expect(method.headers.get("allow")).toBe("GET, HEAD");
    }),
  );

  it.effect("does not serve symlinks, submodules, or missing files", () =>
    Effect.gen(function* () {
      const { serve } = fixture({
        presentRefs: ["main"],
        files: [textFile("index.html", "home")],
        entries: [
          ["alias.html", entry("alias.html", "symlink", "symlink-oid")],
          ["vendor", entry("vendor", "submodule", "submodule-oid")],
        ],
      });

      expect((yield* serve(new Request("https://preview.test/alias.html"))).status).toBe(404);
      expect((yield* serve(new Request("https://preview.test/vendor"))).status).toBe(404);
      expect((yield* serve(new Request("https://preview.test/missing.js"))).status).toBe(404);
    }),
  );

  it.effect("rejects files over the byte limit before reading their contents", () =>
    Effect.gen(function* () {
      const large = file("large.bin", "", "large-oid");
      const { serve, blobReads } = fixture({
        presentRefs: ["wip/thread"],
        files: [{ ...large, bytes: new Uint8Array(PREVIEW_FILE_MAX_BYTES + 1) }],
      });
      const response = yield* serve(new Request("https://preview.test/large.bin"));

      expect(response.status).toBe(413);
      expect(yield* Effect.promise(() => response.text())).toBe("Preview file too large.");
      expect(blobReads).toEqual([]);
    }),
  );
});
