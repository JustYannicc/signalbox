import {
  ATTACHMENT_UPLOAD_URL_TTL_MS,
  type AttachmentCreateUploadUrlInput,
  type AttachmentCreateUploadUrlResult,
  type ChatAttachment,
  ChatAttachmentId,
  getProviderAttachmentLimitError,
  isProviderSendTurnSupportedImageMimeType,
  type PersistChatAttachmentsInput,
  type PersistChatAttachmentsResult,
  PersistChatAttachmentsError,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as CloudTokens from "../auth/CloudTokens.ts";
import * as Ids from "./attachmentIds.ts";
import { type AttachmentStorage, exactly } from "./attachmentObjects.ts";
import { decodeLegacyImages } from "./legacyImages.ts";

/**
 * Pasted screenshots and files in cloud threads, in the EU drives bucket under
 * `<preview prefix>attachments/`, so a preview's are deleted with its prefix.
 * The same three steps as a self-hosted server (`apps/server/src/assets/AttachmentUpload.ts`):
 *
 * 1. `issueUpload` mints a pending id and a signed URL; the client POSTs the bytes there.
 * 2. Sending a message `claim`s each pending upload: it is checked against what
 *    its uploader promised and copied under an id of the thread, which the
 *    message keeps. Pending uploads nobody sent are swept after a day.
 * 3. `CloudAssets` signs short-lived links for those who `canRead` it, and serves them with `open`.
 *    The thread's machine reads them with its session token (`runnerAttachments.ts`)
 *    and keeps them as files for the harness.
 *
 * Limits are the contract's: 10 MiB per image, 50 MiB per file, 80 MiB of
 * images and 100 attachments per message. Nothing here logs names or bytes.
 */

export const ATTACHMENT_UPLOAD_PATH = "/api/attachments/upload";

const PENDING_MAX_AGE_MS = 24 * 60 * 60_000;
const SWEEP_INTERVAL_MS = 15 * 60_000;
const SWEEP_MAX_PAGES = 20;
const CLAIM_CONCURRENCY = 4;

/**
 * Where attachment `id` lives in the bucket. Pending uploads sit apart under
 * `pending/`, so sweeping them never lists a sent one.
 */
export const attachmentKey = (prefix: string, id: string) =>
  Ids.isPending(id) ? `${pendingPrefix(prefix)}${id}` : `${prefix}attachments/${id}`;

const pendingPrefix = (prefix: string) => `${prefix}attachments/pending/`;

/** What each object's custom metadata says, set when its bytes land. */
interface AttachmentMeta {
  readonly owner?: string;
  readonly type?: string;
  readonly mime?: string;
  /** Sent copies only: the thread whose message holds it. */
  readonly thread?: string;
}

const metaOf = (object: { readonly customMetadata?: Record<string, string> | undefined }) =>
  (object.customMetadata ?? {}) as AttachmentMeta;

export class AttachmentRejectedError extends Schema.TaggedError<AttachmentRejectedError>()(
  "AttachmentRejectedError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

/** Why an upload's bytes weren't stored: its URL is unknown or expired, or the body isn't the promised size. */
export type UploadOutcome =
  | { readonly _tag: "stored" }
  | { readonly _tag: "unknown" }
  | { readonly _tag: "wrong-size"; readonly sizeBytes: number };

/** A sent attachment's bytes and the headers they are served with. */
export interface AttachmentFile {
  readonly body: ReadableStream<Uint8Array>;
  readonly size: number;
  readonly headers: Record<string, string>;
}

/** A message's attachments as its thread keeps them, and how to take the copies back. */
export interface Claimed {
  readonly attachments: ReadonlyArray<ChatAttachment>;
  /** Deletes the copies this claim made, for a message the thread then refused. */
  readonly release: Effect.Effect<void>;
}

export class CloudAttachments extends Context.Service<
  CloudAttachments,
  {
    readonly persistImages: (
      userId: string,
      input: PersistChatAttachmentsInput,
    ) => Effect.Effect<PersistChatAttachmentsResult, PersistChatAttachmentsError>;
    readonly issueUpload: (
      userId: string,
      input: AttachmentCreateUploadUrlInput,
    ) => Effect.Effect<AttachmentCreateUploadUrlResult>;
    /** Stores the bytes an upload URL promised; `declaredSize` as the request's Content-Length said. */
    readonly storeUpload: (
      token: string,
      body: ReadableStream<Uint8Array> | null,
      declaredSize: number | null,
    ) => Effect.Effect<UploadOutcome>;
    /** Deletes `userId`'s own pending upload. Sent attachments stay with their messages. */
    readonly deletePending: (userId: string, attachmentId: string) => Effect.Effect<void>;
    /**
     * Whether `userId` may read an attachment: its uploader may, and so may
     * anyone who `canSee` the thread whose message holds it.
     */
    readonly canRead: (
      userId: string,
      attachmentId: string,
      canSee: (threadId: string) => Effect.Effect<boolean>,
    ) => Effect.Effect<boolean>;
    /** The attachment's bytes for `userId`, as `canRead` allows; null otherwise, or once it is gone. */
    readonly open: (input: {
      readonly userId: string;
      readonly attachmentId: string;
      readonly canSee: (threadId: string) => Effect.Effect<boolean>;
      /** The name a download is saved under. */
      readonly fileName?: string | undefined;
      readonly disposition?: "inline" | "attachment" | undefined;
    }) => Effect.Effect<AttachmentFile | null>;
    /**
     * A message's attachments as `threadId` keeps them: each of `userId`'s
     * pending uploads copied under an id of the thread, derived from the
     * command, so a retried command writes the same copies again. The thread's
     * own attachments pass through, as they are stored.
     */
    readonly claim: (input: {
      readonly userId: string;
      readonly threadId: string;
      readonly commandId: string;
      readonly attachments: ReadonlyArray<ChatAttachment>;
    }) => Effect.Effect<Claimed, AttachmentRejectedError>;
  }
>()("@signalbox/cloud/attachments/CloudAttachments") {}

/** R2 failed; logged with its operation, answered without detail. */
class AttachmentStorageError extends Schema.TaggedError<AttachmentStorageError>()(
  "AttachmentStorageError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

const storage = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new AttachmentStorageError({ operation, cause }),
  });

const DOWNLOAD_MIME = /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/;
const isSafeDownloadMime = (mime: string) =>
  DOWNLOAD_MIME.test(mime) && !/(?:^text\/html$|\/xml(?:$|-)|\+xml$)/i.test(mime);

/** RFC 6266 disposition with an ASCII fallback name plus a UTF-8 `filename*`. */
const downloadDisposition = (name: string | undefined) => {
  if (name === undefined) return "attachment";
  // Lone surrogates first: `encodeURIComponent` throws on them.
  const sanitized = name
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "_")
    .replace(/[\p{Cc}"\\]/gu, "_");
  const ascii = sanitized.replace(/[^\u0020-\u007e]/g, "_");
  return ascii === sanitized
    ? `attachment; filename="${ascii}"`
    : `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(sanitized)}`;
};

/**
 * Supported images render inline, and a PDF a viewer asked for inline; anything
 * else downloads, sandboxed. Types come from the upload, never from the link.
 */
const fileHeaders = (
  meta: AttachmentMeta,
  claims: { readonly n?: string | undefined; readonly d?: "inline" | "attachment" | undefined },
): Record<string, string> => {
  const mime = meta.mime?.toLowerCase() ?? "application/octet-stream";
  const base = { "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff" };
  if (isProviderSendTurnSupportedImageMimeType(mime) && claims.d !== "attachment") {
    return { ...base, "content-type": mime };
  }
  if (mime === "application/pdf" && claims.d === "inline") {
    return { ...base, "content-type": mime };
  }
  return {
    ...base,
    "content-type": isSafeDownloadMime(mime) ? mime : "application/octet-stream",
    "content-disposition": downloadDisposition(claims.n),
    "content-security-policy": "default-src 'none'; sandbox",
  };
};

export const layer = ({ objects, prefix }: AttachmentStorage) =>
  Layer.effect(
    CloudAttachments,
    Effect.gen(function* () {
      const tokens = yield* CloudTokens.CloudTokens;
      const crypto = yield* Crypto.Crypto;
      const uuid = Effect.orDie(crypto.randomUUIDv4());
      const keyOf = (id: string) => attachmentKey(prefix, id);
      let lastSweep = Number.NEGATIVE_INFINITY;

      /** Deletes pending uploads older than a day, at most every 15 min. */
      const sweep = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        let cursor: string | undefined;
        let deleted = 0;
        for (let page = 0; page < SWEEP_MAX_PAGES; page++) {
          const listed = yield* storage("list", () =>
            objects.list({
              prefix: pendingPrefix(prefix),
              limit: 1000,
              ...(cursor === undefined ? {} : { cursor }),
            }),
          );
          const stale = listed.objects
            .filter((object) => now - object.uploaded.getTime() > PENDING_MAX_AGE_MS)
            .map((object) => object.key);
          if (stale.length > 0) yield* storage("delete", () => objects.delete(stale));
          deleted += stale.length;
          if (!listed.truncated || listed.cursor === undefined) break;
          cursor = listed.cursor;
        }
        if (deleted > 0) yield* Effect.logInfo("removed expired attachment uploads", { deleted });
      }).pipe(
        Effect.catchTags({
          AttachmentStorageError: (failure) =>
            Effect.logWarning("attachment sweep failed", failure),
        }),
      );

      /** Starts a sweep beside the request when one is due; the upload never waits for it. */
      const sweepWhenDue = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (now - lastSweep < SWEEP_INTERVAL_MS) return;
        lastSweep = now;
        yield* Effect.forkDetach(sweep);
      });

      const issueUpload = Effect.fn("CloudAttachments.issueUpload")(function* (
        userId: string,
        input: AttachmentCreateUploadUrlInput,
      ) {
        const type = input.type ?? "image";
        yield* Effect.annotateCurrentSpan({
          "person.id": userId,
          "attachment.type": type,
          "attachment.bytes": input.sizeBytes,
        });
        yield* sweepWhenDue;
        const attachmentId = Ids.pendingId(
          yield* uuid,
          type === "file" ? Ids.fileExtension(input.name) : null,
        );
        const expiresAt = (yield* Clock.currentTimeMillis) + ATTACHMENT_UPLOAD_URL_TTL_MS;
        const token = yield* tokens.sign({
          _tag: "attachment-upload",
          u: userId,
          a: attachmentId,
          t: type,
          m: input.mimeType.toLowerCase(),
          s: input.sizeBytes,
          exp: expiresAt,
        });
        return { attachmentId, relativeUrl: `${ATTACHMENT_UPLOAD_PATH}/${token}`, expiresAt };
      });

      const storeUpload = Effect.fn("CloudAttachments.storeUpload")(function* (
        token: string,
        body: ReadableStream<Uint8Array> | null,
        declaredSize: number | null,
      ) {
        const claims = yield* tokens.verify("attachment-upload", token).pipe(Effect.option);
        if (claims._tag === "None") return { _tag: "unknown" } satisfies UploadOutcome;
        const { a: id, s: size, u: owner } = claims.value;
        yield* Effect.annotateCurrentSpan({ "person.id": owner, "attachment.bytes": size });
        const wrongSize = { _tag: "wrong-size", sizeBytes: size } satisfies UploadOutcome;
        if (body === null || (declaredSize !== null && declaredSize !== size)) return wrongSize;
        const key = keyOf(id);
        const meta: AttachmentMeta = { owner, type: claims.value.t, mime: claims.value.m };
        // A body of the wrong length fails the write in R2, and is caught by the size check here.
        const stored = yield* storage("put", () =>
          objects.put(key, exactly(body, size), { customMetadata: { ...meta } }),
        ).pipe(
          Effect.andThen(storage("head", () => objects.head(key))),
          Effect.map((head) => head?.size === size),
          Effect.catchTags({
            AttachmentStorageError: (failure) =>
              Effect.logWarning("attachment upload not stored", failure).pipe(Effect.as(false)),
          }),
        );
        if (stored) return { _tag: "stored" } satisfies UploadOutcome;
        yield* storage("delete", () => objects.delete(key)).pipe(Effect.ignore);
        return wrongSize;
      });

      const deletePending: CloudAttachments["Service"]["deletePending"] = (userId, attachmentId) =>
        Effect.gen(function* () {
          if (!Ids.isPending(attachmentId)) return;
          const key = keyOf(attachmentId);
          const head = yield* storage("head", () => objects.head(key));
          if (head === null || metaOf(head).owner !== userId) return;
          yield* storage("delete", () => objects.delete(key));
        }).pipe(
          Effect.catchTags({
            AttachmentStorageError: (failure) =>
              Effect.logWarning("deleting an upload failed", failure),
          }),
        );

      /** Whether `meta`'s attachment is `userId`'s to read. */
      const allows = (
        meta: AttachmentMeta,
        userId: string,
        canSee: (threadId: string) => Effect.Effect<boolean>,
      ) =>
        meta.owner === userId
          ? Effect.succeed(true)
          : meta.thread === undefined
            ? Effect.succeed(false)
            : canSee(meta.thread);

      const readFailed = (failure: AttachmentStorageError) =>
        Effect.logError("reading an attachment failed", failure).pipe(Effect.as(null));

      const canRead: CloudAttachments["Service"]["canRead"] = (userId, attachmentId, canSee) =>
        Ids.parse(attachmentId) === null
          ? Effect.succeed(false)
          : storage("head", () => objects.head(keyOf(attachmentId))).pipe(
              Effect.catchTags({ AttachmentStorageError: readFailed }),
              Effect.flatMap((head) =>
                head === null ? Effect.succeed(false) : allows(metaOf(head), userId, canSee),
              ),
            );

      const open: CloudAttachments["Service"]["open"] = (input) =>
        Effect.gen(function* () {
          if (Ids.parse(input.attachmentId) === null) return null;
          const object = yield* storage("get", () => objects.get(keyOf(input.attachmentId)));
          if (object === null) return null;
          const meta = metaOf(object);
          if (!(yield* allows(meta, input.userId, input.canSee))) {
            yield* Effect.promise(() => object.body.cancel());
            return null;
          }
          return {
            body: object.body,
            size: object.size,
            headers: fileHeaders(meta, { n: input.fileName, d: input.disposition }),
          };
        }).pipe(Effect.catchTags({ AttachmentStorageError: readFailed }));

      /** The thread's id for `pending` as `commandId` sends it: the same on every retry. */
      const sentId = (threadId: string, commandId: string, pending: string) =>
        crypto
          .digest("SHA-256", new TextEncoder().encode(`${threadId}\n${commandId}\n${pending}`))
          .pipe(
            Effect.orDie,
            Effect.map((digest) =>
              ChatAttachmentId.make(Ids.sentId(threadId, Ids.uuidOf(Hex.encode(digest)), pending)),
            ),
          );

      /** One attachment as the thread keeps it, and the key of the copy made for it, if any. */
      const claimOne = (
        input: { readonly userId: string; readonly threadId: string; readonly commandId: string },
        attachment: ChatAttachment,
      ) =>
        Effect.gen(function* (): Effect.fn.Return<
          { readonly attachment: ChatAttachment; readonly copy: string | null },
          AttachmentRejectedError | AttachmentStorageError
        > {
          const reject = (why: string) =>
            new AttachmentRejectedError({ reason: `'${attachment.name}' can't be sent: ${why}` });
          const segment = Ids.parse(attachment.id)?.segment;
          if (attachment.type !== "image" && attachment.type !== "file") {
            return yield* reject("this kind of attachment isn't supported.");
          }
          const head = yield* storage("head", () => objects.head(keyOf(attachment.id)));
          const meta = head === null ? {} : metaOf(head);
          // Already the thread's, as a retried or edited message holds it: kept as stored.
          if (segment === Ids.threadSegment(input.threadId)) {
            if (head === null || meta.thread !== input.threadId) {
              return yield* reject("it isn't an attachment of this thread.");
            }
            return {
              attachment: { ...attachment, sizeBytes: head.size, mimeType: meta.mime ?? "" },
              copy: null,
            };
          }
          if (segment !== Ids.PENDING_SEGMENT) return yield* reject("it isn't an upload of yours.");
          if (head === null || meta.owner !== input.userId) {
            return yield* reject("it is no longer available. Attach it again.");
          }
          const mime = meta.mime ?? "";
          if (
            head.size !== attachment.sizeBytes ||
            meta.type !== attachment.type ||
            (attachment.type === "image" && mime !== attachment.mimeType.toLowerCase())
          ) {
            return yield* reject("it doesn't match its upload.");
          }
          const id = yield* sentId(input.threadId, input.commandId, attachment.id);
          const existing = yield* storage("head", () => objects.head(keyOf(id)));
          if (existing !== null) {
            const saved = metaOf(existing);
            if (
              existing.size !== head.size ||
              saved.thread !== input.threadId ||
              saved.owner !== input.userId ||
              saved.type !== attachment.type ||
              saved.mime !== mime
            ) {
              return yield* reject("its stored copy doesn't match this upload.");
            }
            // A failed retry must never release bytes an earlier send already owns.
            return { attachment: { ...attachment, id, mimeType: mime }, copy: null };
          }
          const source = yield* storage("get", () => objects.get(keyOf(attachment.id)));
          if (source === null) return yield* reject("it is no longer available. Attach it again.");
          const sent: AttachmentMeta = {
            owner: input.userId,
            type: attachment.type,
            mime,
            thread: input.threadId,
          };
          yield* storage("put", () =>
            objects.put(keyOf(id), exactly(source.body, source.size), {
              customMetadata: { ...sent },
            }),
          );
          return { attachment: { ...attachment, id, mimeType: mime }, copy: keyOf(id) };
        });

      const deleteCopies = (keys: ReadonlyArray<string>) =>
        keys.length === 0
          ? Effect.void
          : storage("delete", () => objects.delete([...keys])).pipe(
              Effect.catchTags({
                AttachmentStorageError: (failure) =>
                  Effect.logWarning("releasing attachments failed", failure),
              }),
            );

      const claim = Effect.fn("CloudAttachments.claim")(function* (input: {
        readonly userId: string;
        readonly threadId: string;
        readonly commandId: string;
        readonly attachments: ReadonlyArray<ChatAttachment>;
      }) {
        const { attachments } = input;
        if (attachments.length === 0)
          return { attachments, release: Effect.void } satisfies Claimed;
        yield* Effect.annotateCurrentSpan({
          "person.id": input.userId,
          "thread.id": input.threadId,
          "attachment.count": attachments.length,
          "attachment.bytes": attachments.reduce((total, item) => total + item.sizeBytes, 0),
        });
        const limit = getProviderAttachmentLimitError(attachments);
        if (limit !== undefined) return yield* new AttachmentRejectedError({ reason: limit });
        if (new Set(attachments.map((attachment) => attachment.id)).size !== attachments.length) {
          return yield* new AttachmentRejectedError({
            reason: "An attachment is in this message twice.",
          });
        }
        // Copies made so far, so a failure partway through leaves none behind.
        const copies: Array<string> = [];
        const claimed = yield* Effect.forEach(
          attachments,
          (attachment) =>
            Effect.tap(claimOne(input, attachment), ({ copy }) =>
              Effect.sync(() => {
                if (copy !== null) copies.push(copy);
              }),
            ),
          { concurrency: CLAIM_CONCURRENCY },
        ).pipe(
          Effect.onError(() => deleteCopies(copies)),
          Effect.catchTags({
            AttachmentStorageError: (failure) =>
              Effect.logError("claiming an attachment failed", failure).pipe(
                Effect.andThen(
                  Effect.fail(
                    new AttachmentRejectedError({
                      reason: "Attachments can't be stored right now. Try again.",
                    }),
                  ),
                ),
              ),
          }),
        );
        return {
          attachments: claimed.map(({ attachment }) => attachment),
          release: deleteCopies(copies),
        } satisfies Claimed;
      });

      const persistImages: CloudAttachments["Service"]["persistImages"] = (userId, input) =>
        Effect.gen(function* () {
          const images = yield* decodeLegacyImages(input);
          yield* sweepWhenDue;
          const pending = yield* Effect.forEach(images, ({ attachment, bytes }, index) =>
            Effect.gen(function* () {
              const hash = yield* crypto.digest("SHA-256", bytes).pipe(Effect.orDie);
              const key = [userId, input.threadId, input.messageId, String(index), Hex.encode(hash)]
                .map((part) => `${part.length}:${part}`)
                .join("");
              const digest = yield* crypto
                .digest("SHA-256", new TextEncoder().encode(key))
                .pipe(Effect.orDie);
              const id = ChatAttachmentId.make(Ids.pendingId(Ids.uuidOf(Hex.encode(digest)), null));
              const token = yield* tokens.sign({
                _tag: "attachment-upload",
                u: userId,
                a: id,
                t: "image",
                m: attachment.mimeType,
                s: bytes.byteLength,
                exp: (yield* Clock.currentTimeMillis) + ATTACHMENT_UPLOAD_URL_TTL_MS,
              });
              const stored = yield* storeUpload(
                token,
                new Blob([bytes.slice()]).stream(),
                bytes.byteLength,
              );
              if (stored._tag !== "stored") {
                return yield* new PersistChatAttachmentsError({
                  message: "Attachments can't be stored right now. Try again.",
                });
              }
              return {
                type: "image" as const,
                id,
                name: attachment.name,
                mimeType: attachment.mimeType,
                sizeBytes: bytes.byteLength,
                ...(attachment.source === undefined ? {} : { source: attachment.source }),
              };
            }),
          );
          return { attachments: pending };
        });

      return CloudAttachments.of({
        persistImages,
        issueUpload,
        storeUpload,
        deletePending,
        canRead,
        open,
        claim,
      });
    }),
  );
