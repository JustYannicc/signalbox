import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpEffect from "effect/http/HttpEffect";
import { HttpRouter } from "effect/http";
import * as Layer from "effect/Layer";

import * as CloudSessions from "../auth/CloudSessions.ts";
import * as CloudThreadService from "../thread/CloudThreadService.ts";
import * as ThreadDirectory from "../thread/ThreadDirectory.ts";
import * as Platform from "../platform.ts";
import { makeMemoryObjects } from "../attachments/attachmentTesting.ts";
import {
  CLOUD_TEST_ENV,
  layerAccounts,
  layerAttachments,
  layerPersonalThreadContexts,
  makeMemoryCloud,
} from "../testing.ts";
import { PREVIEW_OPEN_PATH, layer as previewOpenRoutes } from "./previewOpenRoutes.ts";

const USER_ID = "user_preview";
const THREAD_ID = ThreadId.make("thread-preview");
const PORT = 5173;
const PREVIEW_URL = "https://preview.signalbox.test/__signalbox/preview?ticket=short";

const setup = Effect.gen(function* () {
  const cloud = makeMemoryCloud();
  const opened: Array<{
    readonly userId: string;
    readonly threadId: ThreadId;
    readonly port: number;
    readonly handoff: boolean;
  }> = [];
  let unavailable = false;
  let failed = false;
  const threadDirectory: ThreadDirectory.ThreadDirectory["Service"] = {
    forThread: (threadId) => ({
      ...cloud.threadDirectory.forThread(threadId),
      previewLink: (actor, port, handoff) =>
        Effect.sync(() => {
          opened.push({ userId: actor.userId, threadId, port, handoff: handoff === true });
        }).pipe(
          Effect.andThen(
            failed
              ? Effect.fail(
                  new ThreadDirectory.ThreadObjectError({
                    operation: "previewLink",
                    cause: new Error("thread object failed"),
                  }),
                )
              : Effect.succeed(
                  unavailable
                    ? ({ _tag: "unavailable", message: "No service on that port." } as const)
                    : ({ _tag: "ok", url: PREVIEW_URL } as const),
                ),
          ),
        ),
    }),
  };
  const threadService = yield* CloudThreadService.CloudThreadService.pipe(
    Effect.provide(
      Layer.fresh(CloudThreadService.layer).pipe(
        Layer.provide(Layer.succeed(ThreadDirectory.ThreadDirectory, threadDirectory)),
        Layer.provide(layerPersonalThreadContexts(USER_ID)),
        Layer.provide(Platform.layerCrypto),
        Layer.provide(layerAttachments(makeMemoryObjects())),
      ),
    ),
  );
  const context = yield* Layer.build(
    Layer.mergeAll(
      layerAccounts({}, CLOUD_TEST_ENV),
      Layer.succeed(CloudThreadService.CloudThreadService, threadService),
    ),
  );
  const sessions = Context.get(context, CloudSessions.CloudSessions);
  const { token } = yield* sessions.create({ userId: USER_ID, method: "browser-session-cookie" });
  const httpEffect = yield* HttpRouter.toHttpEffect(previewOpenRoutes);
  const handler = HttpEffect.toWebHandler(httpEffect.pipe(Effect.provide(context)));
  const get = (path: string, headers?: HeadersInit) =>
    Effect.promise(() =>
      handler(
        new Request(`https://app.signalbox.test${path}`, headers === undefined ? {} : { headers }),
      ),
    );
  return {
    get,
    opened,
    token,
    setUnavailable: (value: boolean) => {
      unavailable = value;
    },
    setFailed: (value: boolean) => {
      failed = value;
    },
  };
});

describe("thread preview handoff route", () => {
  it.effect("sends a signed-out browser through app sign-in and ignores bearer credentials", () =>
    Effect.gen(function* () {
      const { get, opened } = yield* setup;
      const path = PREVIEW_OPEN_PATH.replace(":threadId", THREAD_ID).replace(":port", `${PORT}`);
      const response = yield* get(path, { authorization: "Bearer app-session" });
      const location = new URL(
        response.headers.get("location") ?? "",
        "https://app.signalbox.test",
      );

      expect(response.status).toBe(302);
      expect(location.pathname).toBe("/sign-in");
      expect(location.searchParams.get("returnTo")).toBe(path);
      expect(opened).toEqual([]);
    }),
  );

  it.effect(
    "authenticates the browser cookie and mints a handoff ticket for the current member",
    () =>
      Effect.gen(function* () {
        const { get, opened, token } = yield* setup;
        const path = PREVIEW_OPEN_PATH.replace(":threadId", THREAD_ID).replace(":port", `${PORT}`);
        const response = yield* get(path, { cookie: `signalbox_cloud_session=${token}` });

        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toBe(PREVIEW_URL);
        expect(opened).toEqual([
          { userId: USER_ID, threadId: THREAD_ID, port: PORT, handoff: true },
        ]);
      }),
  );

  it.effect("hides a missing service behind a short 404", () =>
    Effect.gen(function* () {
      const { get, opened, setUnavailable, token } = yield* setup;
      setUnavailable(true);
      const path = PREVIEW_OPEN_PATH.replace(":threadId", THREAD_ID).replace(":port", `${PORT}`);
      const response = yield* get(path, { cookie: `signalbox_cloud_session=${token}` });

      expect(response.status).toBe(404);
      expect(yield* Effect.promise(() => response.text())).toBe("This preview is unavailable.");
      expect(opened).toEqual([{ userId: USER_ID, threadId: THREAD_ID, port: PORT, handoff: true }]);
    }),
  );

  it.effect("returns a generic server error when the thread object fails", () =>
    Effect.gen(function* () {
      const { get, setFailed, token } = yield* setup;
      setFailed(true);
      const path = PREVIEW_OPEN_PATH.replace(":threadId", THREAD_ID).replace(":port", `${PORT}`);
      const response = yield* get(path, { cookie: `signalbox_cloud_session=${token}` });

      expect(response.status).toBe(500);
      expect(yield* Effect.promise(() => response.text())).toBe("Couldn't open this preview.");
    }),
  );
});
