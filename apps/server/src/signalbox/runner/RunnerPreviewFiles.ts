// @effect-diagnostics nodeBuiltinImport:off - serves the thread workspace through its preview tunnel.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  PREVIEW_FILE_MAX_BYTES,
  previewFileHeaders,
  previewFilePath,
} from "@t3tools/shared/previewFiles";

export interface PreviewFileResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array | null;
}

export interface RunnerPreviewFiles {
  readonly read: (method: string, requestPath: string) => Promise<PreviewFileResponse>;
}

const within = (root: string, target: string) => {
  const path = NodePath.relative(root, target);
  return path !== ".." && !path.startsWith(`..${NodePath.sep}`) && !NodePath.isAbsolute(path);
};

const textResponse = (status: number, message: string, headers: Record<string, string> = {}) => {
  const body = new TextEncoder().encode(message);
  return {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "content-length": String(body.byteLength),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...headers,
    },
    body,
  } satisfies PreviewFileResponse;
};

const notFound = () => textResponse(404, "Not Found");

/** Reads one workspace file without following links outside, or through symlinks within, the checkout. */
export const makeRunnerPreviewFiles = (
  workspace: string,
  platform: NodeJS.Platform,
): RunnerPreviewFiles => {
  let rootPromise: Promise<string> | undefined;
  const root = () => (rootPromise ??= NodeFSP.realpath(workspace));

  const read = async (method: string, requestPath: string): Promise<PreviewFileResponse> => {
    const answer = (response: PreviewFileResponse): PreviewFileResponse =>
      method === "HEAD" ? { ...response, body: null } : response;
    if (method !== "GET" && method !== "HEAD")
      return answer(textResponse(405, "Method Not Allowed", { allow: "GET, HEAD" }));

    const queryAt = requestPath.indexOf("?");
    const pathname = queryAt === -1 ? requestPath : requestPath.slice(0, queryAt);
    const query = queryAt === -1 ? "" : requestPath.slice(queryAt);
    const relativePath = previewFilePath(pathname);
    if (relativePath === null) return answer(notFound());

    const workspaceRoot = await root().catch(() => null);
    if (workspaceRoot === null) return answer(notFound());

    const inspect = async (path: string) => {
      const segments = path.split("/").filter((segment) => segment !== "");
      let current = workspaceRoot;
      for (const segment of segments) {
        current = NodePath.join(current, segment);
        const item = await NodeFSP.lstat(current).catch(() => null);
        if (item === null || item.isSymbolicLink()) return null;
      }
      const item = await NodeFSP.stat(current).catch(() => null);
      return item === null ? null : { path: current, item };
    };

    let file = relativePath === "" ? "index.html" : relativePath;
    let inspected = await inspect(file);
    if (inspected?.item.isDirectory()) {
      if (relativePath !== "" && !relativePath.endsWith("/")) {
        const canonical = relativePath
          .split("/")
          .map((segment) => encodeURIComponent(segment))
          .join("/");
        return answer({
          status: 308,
          headers: {
            location: `/${canonical}/${query}`,
            "content-length": "0",
            "cache-control": "no-store",
          },
          body: null,
        });
      }
      file = NodePath.join(relativePath, "index.html");
      inspected = await inspect(file);
    }
    if (inspected === null || !inspected.item.isFile()) return answer(notFound());

    const filePath = NodePath.resolve(workspaceRoot, file);
    const realPath = await NodeFSP.realpath(filePath).catch(() => null);
    if (realPath === null || !within(workspaceRoot, realPath)) return answer(notFound());

    let handle: Awaited<ReturnType<typeof NodeFSP.open>> | undefined;
    try {
      handle = await NodeFSP.open(
        realPath,
        NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW,
      );
      const openedStat = await handle.stat();
      const descriptorPath = platform === "linux" ? `/proc/self/fd/${handle.fd}` : null;
      if (descriptorPath !== null) {
        const openedPath = await NodeFSP.realpath(descriptorPath).catch(() => null);
        if (openedPath === null || !within(workspaceRoot, openedPath)) return answer(notFound());
      }
      if (!openedStat.isFile()) return answer(notFound());
      if (openedStat.size > PREVIEW_FILE_MAX_BYTES)
        return answer(textResponse(413, "Preview file too large."));
      const body = method === "HEAD" ? null : new Uint8Array(await handle.readFile());
      if (body !== null && body.byteLength > PREVIEW_FILE_MAX_BYTES)
        return answer(textResponse(413, "Preview file too large."));
      return answer({
        status: 200,
        headers: {
          ...previewFileHeaders(file),
          "content-length": String(openedStat.size),
        },
        body,
      });
    } catch {
      return answer(notFound());
    } finally {
      await handle?.close().catch(() => undefined);
    }
  };

  return { read };
};
