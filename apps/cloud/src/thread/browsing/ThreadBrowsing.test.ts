import { CommandId, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import { PERSONAL_POOL_ID } from "@t3tools/contracts/accountHub";
import type { BrowsingMember, BrowsingStreamItem } from "@t3tools/contracts/signalboxBrowsing";
import { PERSONAL_CONTEXT_ID } from "@t3tools/contracts/signalboxContexts";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { layerThreadObject } from "../../testing.ts";
import { scriptedModelSelection } from "../scriptedProvider.ts";
import * as ThreadEngine from "../ThreadEngine.ts";
import { ThreadBrowsing } from "./ThreadBrowsing.ts";

const owner = { userId: "user_1", contextIds: [PERSONAL_CONTEXT_ID] };
const desktop: BrowsingMember = { _tag: "Device", userId: "user_1", deviceId: "desktop" };
const DAY_MS = 86_400_000;

/** A thread object with one thread, and its browsing log. */
const withThread = <A, E>(use: (browsing: ThreadBrowsing["Service"]) => Effect.Effect<A, E>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(layerThreadObject(":memory:"));
      yield* Context.get(context, ThreadEngine.ThreadEngine).launch(
        owner,
        {
          commandId: CommandId.make("launch-1"),
          threadId: ThreadId.make("thread-1"),
          projectId: ProjectId.make("scratch"),
          title: "Read up",
          modelSelection: scriptedModelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
          initialMessage: { messageId: MessageId.make("message-1"), text: "Hi", attachments: [] },
        },
        {
          place: { contextId: PERSONAL_CONTEXT_ID, driveId: "my/personal/user_1" },
          pools: { top: PERSONAL_POOL_ID, projects: {} },
        },
      );
      return yield* use(Context.get(context, ThreadBrowsing));
    }),
  );

describe("ThreadBrowsing sharing", () => {
  it.effect("ends a share on time and tells everyone following the thread", () =>
    withThread((browsing) =>
      Effect.gen(function* () {
        yield* browsing.dispatch(owner, desktop, {
          _tag: "Open",
          tabId: "tab_a",
          url: "https://example.com/",
          activate: true,
        });
        // Nothing to end yet: the alarm isn't asked for.
        expect(yield* browsing.expire).toBeNull();
        const shared = yield* browsing.dispatch(owner, desktop, {
          _tag: "Share",
          tabId: "tab_a",
          audience: "Thread",
          days: 1,
        });
        expect(shared.tab?.sharing?.until).toBe("1970-01-02T00:00:00.000Z");

        const stream = yield* browsing.subscribe(owner, desktop);
        const following = yield* stream.pipe(
          Stream.flatMap((batch) => Stream.fromIterable(batch)),
          Stream.take(2),
          Stream.runCollect,
          Effect.forkChild,
        );
        // Not due yet: the alarm comes back at the end.
        expect(yield* browsing.expire).toBe(DAY_MS);
        yield* TestClock.adjust(DAY_MS);
        expect(yield* browsing.expire).toBeNull();

        const items: ReadonlyArray<BrowsingStreamItem> = yield* Fiber.join(following);
        const ended = items[1];
        expect(ended?._tag === "Event" && ended.event).toMatchObject({
          _tag: "TabUnshared",
          tabId: "tab_a",
          reason: "Expired",
          by: desktop,
        });
        const { record } = yield* browsing.record(owner);
        expect(record.tabs[0]?.sharing).toBeUndefined();
      }),
    ),
  );
});
