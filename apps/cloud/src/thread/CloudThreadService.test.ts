import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { makeMemoryObjects } from "../attachments/attachmentTesting.ts";
import * as Platform from "../platform.ts";
import { PERSONAL_CONTEXT_ID } from "@t3tools/contracts/signalboxContexts";
import { layerAttachments, layerPersonalThreadContexts, makeMemoryCloud } from "../testing.ts";
import * as CloudThreadService from "./CloudThreadService.ts";
import * as ThreadsLive from "./ThreadsLive.ts";
import * as ThreadDirectory from "./ThreadDirectory.ts";
import { browserBehindLine, browserUpdateLine, previewsLine } from "./threadWire.ts";

const actor = { userId: "user_1", contextIds: [PERSONAL_CONTEXT_ID] };
const threadId = ThreadId.make("thread-1");

describe("CloudThreadService", () => {
  it.effect("doesn't reopen a watch whose viewer fell behind the browser", () =>
    Effect.gen(function* () {
      const cloud = makeMemoryCloud();
      let watches = 0;
      const behind = ThreadDirectory.handleFor({
        browserWatch: async () => {
          watches += 1;
          return new ReadableStream({
            start: (controller) => {
              const encoder = new TextEncoder();
              controller.enqueue(encoder.encode(`${browserUpdateLine({ _tag: "offline" })}\n`));
              controller.enqueue(encoder.encode(`${browserBehindLine}\n`));
              controller.close();
            },
          });
        },
      } as Partial<ThreadDirectory.ThreadObjectApi> as ThreadDirectory.ThreadObjectApi);
      const directory: ThreadDirectory.ThreadDirectory["Service"] = {
        forThread: (id) => ({
          ...cloud.threadDirectory.forThread(id),
          browserWatch: behind.browserWatch,
        }),
      };
      const service = yield* CloudThreadService.CloudThreadService.pipe(
        Effect.provide(
          Layer.fresh(CloudThreadService.layer).pipe(
            Layer.provide(ThreadsLive.layer),
            Layer.provide(Layer.succeed(ThreadDirectory.ThreadDirectory, directory)),
            Layer.provide(layerPersonalThreadContexts("user_1")),
            Layer.provide(Platform.layerCrypto),
            Layer.provide(layerAttachments(makeMemoryObjects())),
          ),
        ),
      );
      const updates: Array<unknown> = [];
      const exit = yield* service.browserWatch(actor, threadId, null).pipe(
        Stream.runForEach((update) => Effect.sync(() => updates.push(update))),
        Effect.exit,
      );
      expect(updates).toEqual([{ _tag: "offline" }]);
      expect(Exit.isFailure(exit) && Exit.findErrorOption(exit)).toMatchObject({
        value: { _tag: "BrowserWatchBehindError" },
      });
      expect(watches).toBe(1);
    }),
  );

  it.effect("reads whether the agent has browsed from the previews stream", () =>
    Effect.gen(function* () {
      const handle = ThreadDirectory.handleFor({
        previews: async () =>
          new ReadableStream({
            start: (controller) => {
              const encoder = new TextEncoder();
              controller.enqueue(encoder.encode(`${previewsLine([], false)}\n`));
              controller.enqueue(encoder.encode(`${previewsLine([], true)}\n`));
              controller.close();
            },
          }),
      } as Partial<ThreadDirectory.ThreadObjectApi> as ThreadDirectory.ThreadObjectApi);
      const seen = yield* Stream.runCollect(handle.previews(actor));
      expect(seen).toEqual([
        { ports: [], browsed: false },
        { ports: [], browsed: true },
      ]);
    }),
  );
});
