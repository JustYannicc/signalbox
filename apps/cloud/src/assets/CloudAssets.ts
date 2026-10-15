import {
  AssetAttachmentNotFoundError,
  type AssetCreateUrlResult,
  AssetProjectFaviconNotFoundError,
  type AssetResource,
  AssetWorkspaceAssetInspectionError,
  AssetWorkspaceAssetNotFoundError,
  AssetWorkspaceContextNotFoundError,
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

import * as CloudTokens from "../auth/CloudTokens.ts";
import * as CloudThreadService from "../thread/CloudThreadService.ts";
import type { ThreadObjectError } from "../thread/ThreadDirectory.ts";
import type { Actor } from "../thread/ThreadEngine.ts";

/**
 * Files a client loads by URL rather than over its socket. A cloud serves only
 * the images tools return inline, such as an agent's screenshots: they are in
 * the thread already, so each URL names one by thread, item and index, signed
 * for the user it was issued to (`CloudTokens`). Loading it reads the thread
 * again as that user, so the URL stops working when they lose sight of the
 * thread or the image goes away. Everything else a self-hosted server serves
 * lives on its own disk, which a cloud doesn't have.
 */

export const ASSET_ROUTE_PREFIX = "/api/assets";
/** Same as a self-hosted server's. */
const TOKEN_TTL_MS = 60 * 60 * 1000;

export type ToolOutputImageResource = Extract<
  AssetResource,
  { readonly _tag: "tool-output-image" }
>;

export interface AssetImage {
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

/** The answer a self-hosted server gives for a resource it can't find, for those a cloud never has. */
const notServed = (resource: Exclude<AssetResource, ToolOutputImageResource>) => {
  switch (resource._tag) {
    case "workspace-file":
    case "media-file":
    case "draft-workspace-file":
      return new AssetWorkspaceContextNotFoundError({ resource });
    case "attachment":
      return new AssetAttachmentNotFoundError({ resource });
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
      readonly resource: ToolOutputImageResource;
    } | null>;
    /** The image as `actor` sees the thread now; null when the thread, item, index or bytes are gone. */
    readonly read: (
      actor: Actor,
      resource: ToolOutputImageResource,
    ) => Effect.Effect<AssetImage | null, ThreadObjectError>;
  }
>()("@signalbox/cloud/assets/CloudAssets") {}

const make = Effect.gen(function* () {
  const tokens = yield* CloudTokens.CloudTokens;
  const threads = yield* CloudThreadService.CloudThreadService;

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

  const verify: CloudAssets["Service"]["verify"] = (token) =>
    tokens.verify("tool-output-image", token).pipe(
      Effect.map((claims) => ({
        userId: claims.u,
        resource: {
          _tag: "tool-output-image" as const,
          threadId: ThreadId.make(claims.t),
          itemId: TurnItemId.make(claims.i),
          index: claims.n,
        },
      })),
      Effect.orElseSucceed(() => null),
    );

  return CloudAssets.of({ createUrl, verify, read });
});

export const layer = Layer.effect(CloudAssets, make);
