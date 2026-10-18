export const PREVIEW_FILE_MAX_BYTES = 10 * 1024 * 1024;

/** The same path rules apply to persisted files and the live workspace. */
export function previewFilePath(pathname: string): string | null {
  let path: string;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  // oxlint-disable-next-line no-control-regex -- Control bytes cannot name preview files.
  if (!path.startsWith("/") || /[\\\u0000-\u001f\u007f%]/u.test(path)) return null;
  const segments = path.slice(1).split("/");
  if (segments.some((segment) => segment.startsWith("."))) return null;
  if (segments.some((segment, index) => segment === "" && index !== segments.length - 1))
    return null;
  return segments.join("/");
}

const MIME_TYPES: Readonly<Record<string, string>> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  pdf: "application/pdf",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  wasm: "application/wasm",
  map: "application/json",
};

export const previewFileMime = (path: string): string =>
  MIME_TYPES[path.split(".").at(-1)?.toLowerCase() ?? ""] ?? "application/octet-stream";

export const previewFileHeaders = (path: string) => ({
  "content-type": previewFileMime(path),
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
});
