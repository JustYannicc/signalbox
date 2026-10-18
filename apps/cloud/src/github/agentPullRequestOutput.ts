import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

export type JsonObject = { readonly [key: string]: unknown };
export interface CommentLists {
  readonly issueComments: ReadonlyArray<unknown>;
  readonly reviewComments: ReadonlyArray<unknown>;
  readonly reviews: ReadonlyArray<unknown>;
}

export const parseJson = (text: string | null): unknown | null => {
  if (text === null) return null;
  const decoded = decodeJson(text);
  return Option.isSome(decoded) ? decoded.value : null;
};

export const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const stringField = (value: JsonObject, key: string) =>
  typeof value[key] === "string" ? (value[key] as string) : null;

export const numberField = (value: JsonObject, key: string) =>
  typeof value[key] === "number" && Number.isInteger(value[key]) ? (value[key] as number) : null;

const objectField = (value: JsonObject, key: string) =>
  isObject(value[key]) ? (value[key] as JsonObject) : null;

const arrayField = (value: JsonObject, key: string) =>
  Array.isArray(value[key]) ? (value[key] as ReadonlyArray<unknown>) : null;

export const isOwnedPullRequest = (
  value: unknown,
  expected: { readonly number: number; readonly repository: string; readonly branch: string },
): value is JsonObject => {
  if (!isObject(value)) return false;
  const head = objectField(value, "head");
  const headRepo = head === null ? null : objectField(head, "repo");
  return (
    numberField(value, "number") === expected.number &&
    head !== null &&
    stringField(head, "ref") === expected.branch &&
    headRepo !== null &&
    stringField(headRepo, "full_name") === expected.repository
  );
};

const sanitizeText = (value: unknown, token: string) =>
  typeof value === "string"
    ? token.length === 0
      ? value
      : value.split(token).join("[REDACTED]")
    : null;

const sanitizeUser = (value: unknown, token: string) => {
  if (!isObject(value)) return null;
  const login = sanitizeText(value.login, token);
  return login === null ? null : { login };
};

const safeComment = (value: unknown, token: string, review: boolean) => {
  if (!isObject(value)) return null;
  const id = numberField(value, "id");
  if (id === null) return null;
  const common = {
    id,
    body: sanitizeText(value.body, token),
    url: sanitizeText(value.html_url, token),
    createdAt: sanitizeText(value.created_at, token),
    updatedAt: sanitizeText(value.updated_at, token),
    user: sanitizeUser(value.user, token),
  };
  return review
    ? {
        ...common,
        inReplyToId: numberField(value, "in_reply_to_id"),
        path: sanitizeText(value.path, token),
        diffHunk: sanitizeText(value.diff_hunk, token),
        line: numberField(value, "line"),
        originalLine: numberField(value, "original_line"),
      }
    : common;
};

export const parseComments = (text: string | null): CommentLists | null => {
  const value = parseJson(text);
  if (!isObject(value)) return null;
  const issueComments = arrayField(value, "issueComments");
  const reviewComments = arrayField(value, "reviewComments");
  const reviews = arrayField(value, "reviews");
  if (issueComments === null || reviewComments === null || reviews === null) return null;
  return { issueComments, reviewComments, reviews };
};

export const reviewReplyTarget = (comments: CommentLists, commentId: number) => {
  const selected = comments.reviewComments.find(
    (comment) => isObject(comment) && numberField(comment, "id") === commentId,
  );
  if (!isObject(selected)) return null;
  // GitHub accepts replies only against the top-level comment in a review thread.
  const rootId = numberField(selected, "in_reply_to_id") ?? commentId;
  return comments.reviewComments.some(
    (comment) =>
      isObject(comment) &&
      numberField(comment, "id") === rootId &&
      numberField(comment, "in_reply_to_id") === null,
  )
    ? rootId
    : null;
};

export const commentsOutput = (comments: CommentLists, token: string) => ({
  issueComments: comments.issueComments
    .map((comment) => safeComment(comment, token, false))
    .filter((comment) => comment !== null),
  reviewComments: comments.reviewComments
    .map((comment) => safeComment(comment, token, true))
    .filter((comment) => comment !== null),
  reviews: comments.reviews
    .map((review) => safeReview(review, token))
    .filter((item) => item !== null),
});

const safeReview = (value: unknown, token: string) => {
  if (!isObject(value)) return null;
  const id = numberField(value, "id");
  if (id === null) return null;
  return {
    id,
    body: sanitizeText(value.body, token),
    state: sanitizeText(value.state, token),
    url: sanitizeText(value.html_url, token),
    submittedAt: sanitizeText(value.submitted_at, token),
    user: sanitizeUser(value.user, token),
  };
};

export const createdCommentOutput = (text: string | null, token: string, review: boolean) => {
  const value = parseJson(text);
  return safeComment(value, token, review);
};

export const pullOutput = (pull: JsonObject, token: string) => {
  const base = objectField(pull, "base");
  const head = objectField(pull, "head");
  return {
    number: numberField(pull, "number"),
    title: sanitizeText(pull.title, token),
    body: sanitizeText(pull.body, token),
    state: sanitizeText(pull.state, token),
    draft: typeof pull.draft === "boolean" ? pull.draft : null,
    url: sanitizeText(pull.html_url, token),
    baseBranch: base === null ? null : sanitizeText(base.ref, token),
    headBranch: head === null ? null : sanitizeText(head.ref, token),
    user: sanitizeUser(pull.user, token),
  };
};

const startsWith = (bytes: Uint8Array, signature: ReadonlyArray<number>) =>
  signature.every((byte, index) => bytes[index] === byte);

export const imageMatchesMime = (mimeType: string, bytes: Uint8Array) => {
  switch (mimeType) {
    case "image/png":
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/jpeg":
      return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case "image/gif":
      return (
        startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
        startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
      );
    case "image/webp":
      return (
        bytes.length >= 12 &&
        startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
        bytes[8] === 0x57 &&
        bytes[9] === 0x45 &&
        bytes[10] === 0x42 &&
        bytes[11] === 0x50
      );
    default:
      return false;
  }
};

export const markdownImage = (name: string, url: string) => {
  const alt = name.replace(/[\\[\]]/g, "\\$&");
  const destination = url.replace(/[\\()]/g, "\\$&");
  return `![${alt}](${destination})`;
};

export const sanitizeUrl = (url: string, token: string) => sanitizeText(url, token);
