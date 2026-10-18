import {
  PREVIEW_FILE_MAX_BYTES,
  previewFileHeaders,
  previewFilePath,
} from "@t3tools/shared/previewFiles";
import * as Effect from "effect/Effect";

import type { DriveReader } from "../../drive/DriveReader.ts";

export type PreviewFileReader = Pick<DriveReader, "treeOf" | "entryAt" | "sizes" | "blob"> & {
  readonly drive: Pick<DriveReader["drive"], "ref">;
};

type PreviewReadError = Effect.Error<ReturnType<PreviewFileReader["treeOf"]>>;
type TreeOid = Effect.Success<ReturnType<PreviewFileReader["treeOf"]>>;

const response = (
  status: number,
  message: string,
  method: string,
  headers?: Readonly<Record<string, string>>,
) =>
  new Response(method === "HEAD" ? null : message, {
    status,
    headers: { "cache-control": "no-store", ...headers },
  });

const safeRoot = (root: ReadonlyArray<string>) =>
  root.every(
    (segment) =>
      segment !== "" && !segment.startsWith(".") && !/[\\/\u0000-\u001f\u007f%]/u.test(segment),
  );

/**
 * Reads one immutable drive tree as static preview files. The caller must use
 * this source only while the thread has no attached machine; a live machine's
 * workspace is newer than its saved drive refs.
 */
export const makePreviewFiles =
  (reader: PreviewFileReader, refs: ReadonlyArray<string>, root: ReadonlyArray<string> = []) =>
  (request: Request): Effect.Effect<Response, PreviewReadError> =>
    Effect.gen(function* () {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return response(405, "Method Not Allowed", request.method, { allow: "GET, HEAD" });
      }

      const path = previewFilePath(new URL(request.url).pathname);
      if (path === null || !safeRoot(root)) {
        return response(404, "Not Found", request.method);
      }

      let tree: TreeOid | null = null;
      for (const ref of refs) {
        const commit = yield* reader.drive.ref(ref);
        if (commit === null) continue;
        tree = yield* reader.treeOf(commit);
        break;
      }
      if (tree === null) return response(404, "Not Found", request.method);

      const pathSegments = path === "" ? [] : path.split("/").filter(Boolean);
      const directoryRequest = path === "" || path.endsWith("/");
      const requested = [...root, ...pathSegments];
      let entry = yield* reader.entryAt(tree, requested);
      if (directoryRequest && entry !== null && entry.kind !== "directory") {
        return response(404, "Not Found", request.method);
      }
      if (entry?.kind === "directory" && !directoryRequest) {
        const url = new URL(request.url);
        url.pathname += "/";
        return new Response(null, {
          status: 308,
          headers: { location: url.toString(), "cache-control": "no-store" },
        });
      }
      if (entry?.kind === "directory" && directoryRequest) {
        entry = yield* reader.entryAt(tree, [...requested, "index.html"]);
      }
      if (
        entry === null ||
        entry.kind === "directory" ||
        entry.kind === "symlink" ||
        entry.kind === "submodule"
      ) {
        return response(404, "Not Found", request.method);
      }

      const headers = previewFileHeaders(entry.name);
      const size = (yield* reader.sizes([entry.oid])).get(entry.oid);
      if (size !== undefined && size !== null && size > PREVIEW_FILE_MAX_BYTES) {
        return response(413, "Preview file too large.", request.method, headers);
      }
      if (request.method === "HEAD" && size !== undefined && size !== null) {
        return new Response(null, {
          headers: { ...headers, "content-length": String(size) },
        });
      }
      const bytes = yield* reader.blob(entry.oid);
      if (bytes.length > PREVIEW_FILE_MAX_BYTES) {
        return response(413, "Preview file too large.", request.method, headers);
      }
      return new Response(request.method === "HEAD" ? null : bytes, {
        headers: { ...headers, "content-length": String(bytes.length) },
      });
    });
