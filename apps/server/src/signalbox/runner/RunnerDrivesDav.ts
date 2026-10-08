import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { ContextClientError } from "./RunnerContextClient.ts";
import { DRIVES_ROOT, type DrivesEntry, type DrivesView } from "./RunnerDrivesView.ts";

/**
 * `/drives` as a read-only WebDAV share, which `rclone mount` turns into the
 * machine's `/drives` folder (`RunnerDrivesMount.ts`). Only what a read-only
 * mount asks for: `PROPFIND` (depth 0 or 1), `GET` and `HEAD` with ranges, and
 * `OPTIONS`. Every write method is refused; the mount is read-only besides.
 */

export const DAV_PATH = "/dav";

export interface DavRequest {
  readonly method: string;
  /** The URL's path, still percent-encoded. */
  readonly path: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
}

export interface DavResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | Uint8Array;
}

const text = (status: number, body: string): DavResponse => ({
  status,
  headers: { "content-type": "text/plain; charset=utf-8" },
  body,
});

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (n: number) => String(n).padStart(2, "0");

/** Seconds since the epoch as an HTTP date: `Sun, 06 Nov 1994 08:49:37 GMT`. */
const httpDate = (seconds: number) => {
  const p = DateTime.toPartsUtc(DateTime.makeUnsafe(seconds * 1000));
  return `${DAYS[p.weekDay]}, ${two(p.day)} ${MONTHS[p.month - 1]} ${p.year} ${two(p.hour)}:${two(p.minute)}:${two(p.second)} GMT`;
};

const escapeXml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const hrefOf = (segments: ReadonlyArray<string>, directory: boolean) =>
  `${DAV_PATH}/${segments.map(encodeURIComponent).join("/")}${directory && segments.length > 0 ? "/" : ""}`;

const responseXml = (segments: ReadonlyArray<string>, entry: DrivesEntry) => {
  const directory = entry.kind === "directory";
  return [
    "<D:response>",
    `<D:href>${escapeXml(hrefOf(segments, directory))}</D:href>`,
    "<D:propstat><D:prop>",
    `<D:displayname>${escapeXml(entry.name)}</D:displayname>`,
    directory ? "<D:resourcetype><D:collection/></D:resourcetype>" : "<D:resourcetype/>",
    directory ? "" : `<D:getcontentlength>${entry.size}</D:getcontentlength>`,
    `<D:getlastmodified>${httpDate(entry.time)}</D:getlastmodified>`,
    "</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>",
    "</D:response>",
  ].join("");
};

/**
 * `bytes=a-b`, `bytes=a-` or `bytes=-n` against `size`, as RFC 9110 reads
 * them: null (serve the whole file) for no range, one that isn't valid, or an
 * empty file; "unsatisfiable" for one that starts past the end.
 */
const parseRange = (header: string | undefined, size: number) => {
  const match = header === undefined ? null : /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null || (match[1] === "" && match[2] === "") || size === 0) return null;
  const [first, last] = [match[1]!, match[2]!];
  if (first !== "" && last !== "" && Number(first) > Number(last)) return null;
  if (first === "") {
    const suffix = Number(last);
    return suffix === 0 ? "unsatisfiable" : { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(first);
  const end = last === "" ? size - 1 : Math.min(size - 1, Number(last));
  return start >= size ? "unsatisfiable" : { start, end };
};

/** Serves one WebDAV request from `view`. */
export const serveDav = (
  view: DrivesView,
  request: DavRequest,
): Effect.Effect<DavResponse, ContextClientError> =>
  Effect.gen(function* () {
    if (request.path !== DAV_PATH && !request.path.startsWith(`${DAV_PATH}/`)) {
      return text(404, "Not found.");
    }
    let segments: ReadonlyArray<string>;
    try {
      segments = request.path
        .slice(DAV_PATH.length)
        .split("/")
        .filter((segment) => segment !== "")
        .map(decodeURIComponent);
    } catch {
      return text(400, "Bad path.");
    }
    const path = [DRIVES_ROOT, ...segments].join("/");
    switch (request.method) {
      case "OPTIONS":
        return {
          status: 200,
          headers: { dav: "1", allow: "OPTIONS, PROPFIND, GET, HEAD" },
          body: "",
        };
      case "PROPFIND": {
        const node = yield* view.stat(path);
        if (node._tag === "missing") return text(404, "Not found.");
        const name = segments.at(-1) ?? "drives";
        const self: DrivesEntry =
          node._tag === "file"
            ? { ...node.entry, name }
            : { name, kind: "directory", size: 0, time: node.time };
        const children =
          node._tag === "directory" && request.headers["depth"] !== "0"
            ? ((yield* view.list(path)) ?? [])
            : [];
        const body = [
          '<?xml version="1.0" encoding="utf-8"?>',
          '<D:multistatus xmlns:D="DAV:">',
          responseXml(segments, self),
          ...children.map((child) => responseXml([...segments, child.name], child)),
          "</D:multistatus>",
        ].join("");
        return {
          status: 207,
          headers: { "content-type": 'application/xml; charset="utf-8"' },
          body,
        };
      }
      case "GET":
      case "HEAD": {
        const node = yield* view.stat(path);
        if (node._tag === "missing") return text(404, "Not found.");
        if (node._tag === "directory") return text(405, "A folder has no contents to read.");
        const lastModified = httpDate(node.entry.time);
        const size = node.entry.size;
        const range = parseRange(request.headers["range"], size);
        if (range === "unsatisfiable") {
          return { status: 416, headers: { "content-range": `bytes */${size}` }, body: "" };
        }
        const common = {
          "accept-ranges": "bytes",
          "content-type": "application/octet-stream",
          "last-modified": lastModified,
        };
        if (request.method === "HEAD") {
          return { status: 200, headers: { ...common, "content-length": String(size) }, body: "" };
        }
        const read = yield* view.read(path, null, node);
        if (read._tag === "too_large") return text(413, "The file is too big to read here.");
        if (read._tag !== "file") return text(404, "Not found.");
        if (range === null) {
          return {
            status: 200,
            headers: { ...common, "content-length": String(read.bytes.length) },
            body: read.bytes,
          };
        }
        const part = read.bytes.subarray(range.start, range.end + 1);
        return {
          status: 206,
          headers: {
            ...common,
            "content-length": String(part.length),
            "content-range": `bytes ${range.start}-${range.end}/${size}`,
          },
          body: part,
        };
      }
      default:
        return text(403, "/drives is read-only. Change another drive from a thread in it.");
    }
  });
