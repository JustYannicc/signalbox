/**
 * Paths inside a drive, as the cloud and a machine both read them:
 * slash-separated and relative to the drive's root, where `""` is the root.
 */

/** Splits a drive path into segments; `""` is the root. Null for one that climbs out. */
export const pathSegments = (path: string): ReadonlyArray<string> | null => {
  const segments = path.split("/").filter((segment) => segment !== "" && segment !== ".");
  return segments.includes("..") ? null : segments;
};

/** Whether `path` is `folder` or inside it. Both are normalized drive paths. */
export const isWithin = (path: string, folder: string) =>
  path === folder || path.startsWith(`${folder}/`);
