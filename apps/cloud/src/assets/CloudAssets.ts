import {
  AssetAttachmentNotFoundError,
  type AssetCreateUrlResult,
  AssetProjectFaviconNotFoundError,
  type AssetResource,
  AssetWorkspaceAssetInspectionError,
  AssetWorkspaceAssetNotFoundError,
  AssetWorkspaceContextNotFoundError,
  type PersistChatAttachmentsInput,
  type PersistChatAttachmentsResult,
  PersistChatAttachmentsError,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { readImageDimensions } from "@t3tools/shared/imageDimensions";
import { MAX_TOOL_OUTPUT_IMAGE_BASE64_LENGTH, toolOutputImages } from "@t3tools/shared/toolOutput";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";

import { type AttachmentFile, CloudAttachments } from "../attachments/CloudAttachments.ts";
import * as CloudTokens from "../auth/CloudTokens.ts";
import * as CloudThreadService from "../thread/CloudThreadService.ts";
import type { ThreadObjectError } from "../thread/ThreadDirectory.ts";
import type { Actor } from "../thread/ThreadEngine.ts";

/**
 * Files a client loads by URL rather than over its socket. A cloud serves two:
 *
 * - The images tools return inline, such as an agent's screenshots: they are
 *   in the thread already, so each URL names one by thread, item and index.
 * - Attachments, the screenshots and files people send (`attachments/`), by id.
 *
 * Each URL is signed for the user it was issued to (`CloudTokens`). Loading it
 * checks again as that user, so the URL stops working when they lose sight of
 * the thread or the file goes away. Everything else a self-hosted server serves
 * lives on its own disk, which a cloud doesn't have.
 */

export const ASSET_ROUTE_PREFIX = "/api/assets";
/** Same as a self-hosted server's. */
const TOKEN_TTL_MS = 60 * 60 * 1000;

export type ToolOutputImageResource = Extract<
  AssetResource,
  { readonly _tag: "tool-output-image" }
>;

export type AttachmentResource = Extract<AssetResource, { readonly _tag: "attachment" }>;

/** What a URL's token grants: one tool image or one attachment. */
export type GrantedResource = ToolOutputImageResource | AttachmentResource;

export interface AssetImage {
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

/** The answer a self-hosted server gives for a resource it can't find, for those a cloud never has. */
const notServed = (resource: Exclude<AssetResource, GrantedResource>) => {
  switch (resource._tag) {
    case "workspace-file":
    case "media-file":
    case "draft-workspace-file":
      return new AssetWorkspaceContextNotFoundError({ resource });
    case "project-favicon":
      return new AssetProjectFaviconNotFoundError({ resource });
    case "native-app-icon":
    case "github-media":
      return new AssetWorkspaceAssetNotFoundError({ resource });
  }
};

export class CloudAssets extends Context.Service<
  CloudAssets,
  {
    readonly persistChatAttachments: (
      actor: Actor,
      input: PersistChatAttachmentsInput,
    ) => Effect.Effect<PersistChatAttachmentsResult, PersistChatAttachmentsError>;
    /** A short-lived URL, relative to the cloud's origin, that loads `resource` for `actor`. */
    readonly createUrl: (
      actor: Actor,
      resource: AssetResource,
    ) => Effect.Effect<
      AssetCreateUrlResult,
      | AssetWorkspaceContextNotFoundError
      | AssetAttachmentNotFoundError
      | AssetProjectFaviconNotFoundError
      | AssetWorkspaceAssetNotFoundError
      | AssetWorkspaceAssetInspectionError
    >;
    /** Who a URL's token was issued to and what it names; null unless this cloud signed it and it is unexpired. */
    readonly verify: (token: string) => Effect.Effect<{
      readonly userId: string;
      readonly resource: GrantedResource;
    } | null>;
    /** The image as `actor` sees the thread now; null when the thread, item, index or bytes are gone. */
    readonly read: (
      actor: Actor,
      resource: ToolOutputImageResource,
    ) => Effect.Effect<AssetImage | null, ThreadObjectError>;
    /** The attachment's bytes as `actor` may read them now; null when they can't or it is gone. */
    readonly openAttachment: (
      actor: Actor,
      resource: AttachmentResource,
    ) => Effect.Effect<AttachmentFile | null>;
  }
>()("@signalbox/cloud/assets/CloudAssets") {}

const make = Effect.gen(function* () {
  const tokens = yield* CloudTokens.CloudTokens;
  const threads = yield* CloudThreadService.CloudThreadService;
  const attachments = yield* CloudAttachments;
  /** Whether `actor` sees a thread an attachment belongs to. */
  const canSee = (actor: Actor) => (threadId: string) =>
    threads.canSee(actor, ThreadId.make(threadId));

  /** A URL for an attachment `actor` may read, named for whoever saves it. */
  const attachmentUrl = (actor: Actor, resource: AttachmentResource) =>
    Effect.gen(function* () {
      if (!(yield* attachments.canRead(actor.userId, resource.attachmentId, canSee(actor)))) {
        return yield* new AssetAttachmentNotFoundError({ resource });
      }
      const expiresAt = (yield* Clock.currentTimeMillis) + TOKEN_TTL_MS;
      const token = yield* tokens.sign({
        _tag: "attachment-file",
        u: actor.userId,
        a: resource.attachmentId,
        ...(resource.fileName === undefined ? {} : { n: resource.fileName }),
        ...(resource.disposition === undefined ? {} : { d: resource.disposition }),
        exp: expiresAt,
      });
      const fileName = encodeURIComponent(resource.fileName ?? resource.attachmentId);
      return { relativeUrl: `${ASSET_ROUTE_PREFIX}/${token}/${fileName}`, expiresAt };
    });

  const read: CloudAssets["Service"]["read"] = (actor, resource) =>
    threads.threadSnapshot(actor, resource.threadId).pipe(
      Effect.map(({ projection }) => {
        const item = projection.turnItems.find((candidate) => candidate.id === resource.itemId);
        const image =
          item?.type === "dynamic_tool" ? toolOutputImages(item.output)[resource.index] : undefined;
        if (image?.data === undefined || image.data.length > MAX_TOOL_OUTPUT_IMAGE_BASE64_LENGTH) {
          return null;
        }
        const bytes = Base64.decode(image.data);
        return Result.isSuccess(bytes) ? { mimeType: image.mimeType, bytes: bytes.success } : null;
      }),
      Effect.catchTags({ ThreadNotFoundError: () => Effect.succeed(null) }),
    );

  const createUrl: CloudAssets["Service"]["createUrl"] = (actor, resource) =>
    Effect.gen(function* () {
      if (resource._tag === "attachment") return yield* attachmentUrl(actor, resource);
      if (resource._tag !== "tool-output-image") return yield* notServed(resource);
      const image = yield* read(actor, resource).pipe(
        Effect.mapError((cause) => new AssetWorkspaceAssetInspectionError({ resource, cause })),
      );
      if (image === null) return yield* new AssetWorkspaceAssetNotFoundError({ resource });
      const expiresAt = (yield* Clock.currentTimeMillis) + TOKEN_TTL_MS;
      const token = yield* tokens.sign({
        _tag: "tool-output-image",
        u: actor.userId,
        t: resource.threadId,
        i: resource.itemId,
        n: resource.index,
        exp: expiresAt,
      });
      // The allowed types are all `image/<extension>`.
      const fileName = `image-${resource.index + 1}.${image.mimeType.slice("image/".length)}`;
      const imageDimensions = readImageDimensions(image.bytes);
      return {
        relativeUrl: `${ASSET_ROUTE_PREFIX}/${token}/${encodeURIComponent(fileName)}`,
        expiresAt,
        ...(imageDimensions === null ? {} : { imageDimensions }),
      };
    });

  const verifyImage = (token: string) =>
    tokens.verify("tool-output-image", token).pipe(
      Effect.map((claims) => ({
        userId: claims.u,
        resource: {
          _tag: "tool-output-image" as const,
          threadId: ThreadId.make(claims.t),
          itemId: TurnItemId.make(claims.i),
          index: claims.n,
        } satisfies GrantedResource,
      })),
    );

  const verifyAttachment = (token: string) =>
    tokens.verify("attachment-file", token).pipe(
      Effect.map((claims) => ({
        userId: claims.u,
        resource: {
          _tag: "attachment" as const,
          attachmentId: claims.a,
          ...(claims.n === undefined ? {} : { fileName: claims.n }),
          ...(claims.d === undefined ? {} : { disposition: claims.d }),
        } satisfies GrantedResource,
      })),
    );

  const verify: CloudAssets["Service"]["verify"] = (token) =>
    verifyImage(token).pipe(
      Effect.catch(() => verifyAttachment(token)),
      Effect.orElseSucceed(() => null),
    );

  const openAttachment: CloudAssets["Service"]["openAttachment"] = (actor, resource) =>
    attachments.open({
      userId: actor.userId,
      attachmentId: resource.attachmentId,
      canSee: canSee(actor),
      fileName: resource.fileName,
      disposition: resource.disposition,
    });

  const persistChatAttachments: CloudAssets["Service"]["persistChatAttachments"] = (actor, input) =>
    threads.threadSnapshot(actor, input.threadId).pipe(
      Effect.mapError(() => new PersistChatAttachmentsError({ message: "Thread unavailable." })),
      Effect.andThen(attachments.persistImages(actor.userId, input)),
    );

  return CloudAssets.of({ createUrl, verify, read, openAttachment, persistChatAttachments });
});

export const layer = Layer.effect(CloudAssets, make);
