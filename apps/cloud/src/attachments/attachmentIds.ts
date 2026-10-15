/**
 * Attachment ids, in the self-hosted server's format (`apps/server/src/attachmentStore.ts`),
 * so a Runner resolves a cloud attachment to a file the same way a server does:
 *
 * - `pending-<uuid>[-<ext>]`: an upload nobody has sent yet.
 * - `<thread segment>-<uuid>[-<ext>]`: the copy a message holds, minted when it is sent.
 *
 * A file's extension rides in its id; an image's comes from its mime type.
 */

export const PENDING_SEGMENT = "pending";
const SEGMENT_MAX_CHARS = 80;
const ID_PATTERN =
  /^([a-z0-9_]+(?:-[a-z0-9_]+)*)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:-([a-z0-9]{1,10}))?$/;

/** The id prefix for `threadId`'s attachments. Never `pending`, so a sent copy is never pending. */
export function threadSegment(threadId: string): string {
  const segment = threadId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, SEGMENT_MAX_CHARS)
    .replace(/[-_]+$/g, "");
  if (segment.length === 0) return "thread";
  return segment === PENDING_SEGMENT ? "_pending" : segment;
}

/** `name`'s extension as an id suffix, `bin` when it has none worth keeping. */
export function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  const extension = dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
  // `part` is reserved for in-flight uploads on a server.
  return /^[a-z0-9]{1,10}$/.test(extension) && extension !== "part" ? extension : "bin";
}

const make = (segment: string, uuid: string, extension: string | null) =>
  `${segment}-${uuid.toLowerCase()}${extension === null ? "" : `-${extension}`}`;

export const pendingId = (uuid: string, extension: string | null) =>
  make(PENDING_SEGMENT, uuid, extension);

/** The id a sent copy of `pending` gets in `threadId`, keeping its extension. */
export const sentId = (threadId: string, uuid: string, pending: string) =>
  make(threadSegment(threadId), uuid, parse(pending)?.extension ?? null);

/** A UUID-shaped string from the first 32 hex digits of `hex`, for ids derived from a digest. */
export const uuidOf = (hex: string) =>
  `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;

export function parse(id: string) {
  const match = ID_PATTERN.exec(id);
  if (match === null) return null;
  return { segment: match[1]!, extension: match[3] ?? null };
}

export const isPending = (id: string) => parse(id)?.segment === PENDING_SEGMENT;
