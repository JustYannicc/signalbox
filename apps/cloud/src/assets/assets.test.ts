import { describe, expect, it } from "@effect/vitest";
import {
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as HttpEffect from "effect/http/HttpEffect";
import { HttpRouter } from "effect/http";

import * as CloudTokens from "../auth/CloudTokens.ts";
import { makeMemoryObjects } from "../attachments/attachmentTesting.ts";
import { layerAttachments, layerConfig, makeMemoryCloud } from "../testing.ts";
import * as CloudThreadService from "../thread/CloudThreadService.ts";
import { ThreadNotFoundError } from "../thread/ThreadEngine.ts";
import * as UserDirectory from "../user/UserDirectory.ts";
import * as AssetRoutes from "./assetRoutes.ts";
import * as CloudAssets from "./CloudAssets.ts";

const threadId = ThreadId.make("thread-1");
const itemId = TurnItemId.make("item-1");
const owner = "user_ada";
const stranger = "user_bob";

/** The header of a 3x2 PNG: enough for its dimensions, and bytes to compare. */
const png = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 3,
  0, 0, 0, 2, 8, 6, 0, 0, 0,
]);

/** A screenshot tool's result, as the Runner forwards it: MCP content with the bytes inline. */
const screenshot: OrchestrationV2TurnItem = {
  type: "dynamic_tool",
  id: itemId,
  threadId,
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status: "completed",
  title: null,
  startedAt: null,
  completedAt: null,
  updatedAt: DateTime.makeUnsafe(0),
  toolName: "preview_snapshot",
  input: { includeImage: true },
  output: {
    content: [
      { type: "text", text: "Captured the page." },
      { type: "image", mimeType: "image/png", data: Base64.encode(png) },
    ],
  },
};

const unused = () => Effect.die("not used by assets");

/** Only `owner` sees the thread, which has the one screenshot. */
const threads = CloudThreadService.CloudThreadService.of({
  threadSnapshot: (actor, id) =>
    actor.userId === owner && id === threadId
      ? Effect.succeed({
          snapshotSequence: 1,
          // Only the items matter here.
          projection: { turnItems: [screenshot] } as unknown as OrchestrationV2ThreadProjection,
          historyCursor: null,
          hasMoreHistory: false,
          latestLocalTurnOrdinal: 0,
        })
      : Effect.fail(new ThreadNotFoundError()),
  dispatchCommand: unused,
  launchThread: unused,
  threadHistoryPage: unused,
  requestPullRequestSync: unused,
  subscribeThread: () => Stream.die("not used by assets"),
  previews: () => Stream.die("not used by assets"),
  browsing: () => Stream.die("not used by assets"),
  browse: () => Effect.die("not used by assets"),
  browsingRecord: () => Effect.die("not used by assets"),
  openPreview: unused,
  browserWatch: () => Stream.die("not used by assets"),
  browserInput: unused,
  browserTrail: unused,
  browserStep: unused,
  turnDiagnostics: unused,
  pull: unused,
  pullOwner: unused,
  pullTarget: unused,
  reservePublication: unused,
  releasePublication: unused,
  canSee: (actor, id) => Effect.succeed(actor.userId === owner && id === threadId),
});

const layer = CloudAssets.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      CloudTokens.layer,
      Layer.succeed(CloudThreadService.CloudThreadService, threads),
      Layer.sync(UserDirectory.UserDirectory, () => makeMemoryCloud().userDirectory),
      layerAttachments(makeMemoryObjects()),
    ),
  ),
  Layer.provideMerge(layerConfig()),
);

const resource = (index = 0) => ({ _tag: "tool-output-image" as const, threadId, itemId, index });

const actor = (userId: string) => ({ userId, contextIds: [] });

/** The token in a URL `createUrl` returned. */
const tokenOf = (relativeUrl: string) => relativeUrl.split("/")[3] ?? "";

/** `token` with its claims rewritten and its signature kept. */
const tampered = (token: string, change: (claims: Record<string, unknown>) => void) => {
  const [payload = "", signature = ""] = token.split(".");
  const decoded = Base64Url.decode(payload);
  if (!Result.isSuccess(decoded)) throw new Error("not a token");
  const claims = JSON.parse(new TextDecoder().decode(decoded.success));
  change(claims);
  return `${Base64Url.encode(new TextEncoder().encode(JSON.stringify(claims)))}.${signature}`;
};

/** The asset route as the Worker serves it (`app.ts`). */
const routeHandler = Effect.gen(function* () {
  const context = yield* Effect.context<Layer.Success<typeof layer>>();
  const httpEffect = yield* HttpRouter.toHttpEffect(AssetRoutes.layer);
  const handler = HttpEffect.toWebHandler(httpEffect.pipe(Effect.provide(context)));
  return (path: string) => Effect.promise(() => handler(new Request(`https://cloud.test${path}`)));
});

describe("CloudAssets", () => {
  it.effect("signs a short URL for an image the user can see, with its size", () =>
    Effect.gen(function* () {
      const assets = yield* CloudAssets.CloudAssets;
      const url = yield* assets.createUrl(actor(owner), resource());
      expect(url.relativeUrl).toMatch(/^\/api\/assets\/[\w-]+\.[\w-]+\/image-1\.png$/);
      expect(url.relativeUrl.length).toBeLessThanOrEqual(4096);
      expect(url.expiresAt).toBe(60 * 60 * 1000);
      expect(url.imageDimensions).toEqual({ width: 3, height: 2 });
      expect(yield* assets.verify(tokenOf(url.relativeUrl))).toEqual({
        userId: owner,
        resource: resource(),
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("finds nothing the user can't see, nor an index the item doesn't have", () =>
    Effect.gen(function* () {
      const assets = yield* CloudAssets.CloudAssets;
      const strangers = yield* Effect.flip(assets.createUrl(actor(stranger), resource()));
      expect(strangers._tag).toBe("AssetWorkspaceAssetNotFoundError");
      const missing = yield* Effect.flip(assets.createUrl(actor(owner), resource(1)));
      expect(missing._tag).toBe("AssetWorkspaceAssetNotFoundError");
      const attachment = yield* Effect.flip(
        assets.createUrl(actor(owner), { _tag: "attachment", attachmentId: "a-1" }),
      );
      expect(attachment._tag).toBe("AssetAttachmentNotFoundError");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("accepts only its own unexpired, untouched tokens", () =>
    Effect.gen(function* () {
      const assets = yield* CloudAssets.CloudAssets;
      const token = tokenOf((yield* assets.createUrl(actor(owner), resource())).relativeUrl);
      expect(yield* assets.verify(tampered(token, (claims) => (claims.u = stranger)))).toBeNull();
      expect(yield* assets.verify(tampered(token, (claims) => (claims.n = 1)))).toBeNull();
      expect(yield* assets.verify(`${token}x`)).toBeNull();
      // A session token is signed with the same key, but isn't an asset grant.
      const session = yield* (yield* CloudTokens.CloudTokens).sign({
        _tag: "session",
        u: owner,
        sid: "s-1",
        exp: Number.MAX_SAFE_INTEGER,
      });
      expect(yield* assets.verify(session)).toBeNull();
      yield* TestClock.adjust("59 minutes");
      expect(yield* assets.verify(token)).not.toBeNull();
      yield* TestClock.adjust("1 minute");
      expect(yield* assets.verify(token)).toBeNull();
    }).pipe(Effect.provide(layer)),
  );
});

// Live clock: the route checks expiry against the real one.
describe("asset route", () => {
  it.live("serves the image's bytes to whoever holds the URL", () =>
    Effect.gen(function* () {
      const get = yield* routeHandler;
      const url = yield* (yield* CloudAssets.CloudAssets).createUrl(actor(owner), resource());
      const response = yield* get(url.relativeUrl);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(response.headers.get("cache-control")).toBe("private, max-age=3600");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      const body = new Uint8Array(yield* Effect.promise(() => response.arrayBuffer()));
      expect(body).toEqual(png);
    }).pipe(Effect.provide(layer)),
  );

  it.live("404s a missing index, a tampered token, and a user who can't see the thread", () =>
    Effect.gen(function* () {
      const get = yield* routeHandler;
      const tokens = yield* CloudTokens.CloudTokens;
      const exp = (yield* Clock.currentTimeMillis) + 60_000;
      const grant = (userId: string, index: number) =>
        tokens.sign({
          _tag: "tool-output-image",
          u: userId,
          t: threadId,
          i: itemId,
          n: index,
          exp,
        });
      expect((yield* get(`/api/assets/${yield* grant(owner, 0)}/image-1.png`)).status).toBe(200);
      expect((yield* get(`/api/assets/${yield* grant(owner, 1)}/image-2.png`)).status).toBe(404);
      expect((yield* get(`/api/assets/${yield* grant(stranger, 0)}/image-1.png`)).status).toBe(404);
      const forged = tampered(yield* grant(stranger, 0), (claims) => (claims.u = owner));
      expect((yield* get(`/api/assets/${forged}/image-1.png`)).status).toBe(404);
      expect((yield* get(`/api/assets/nonsense/image-1.png`)).status).toBe(404);
    }).pipe(Effect.provide(layer)),
  );
});
