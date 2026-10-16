import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthPreviewOperateScope,
  CommandId,
  EnvironmentId,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import {
  type BrowsingStreamItem,
  SIGNALBOX_BROWSING_WS_METHODS,
} from "@t3tools/contracts/signalboxBrowsing";
import { foldBrowsingItem, INITIAL_BROWSING_STATE } from "@t3tools/client-runtime/browsing";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as RpcTest from "effect/rpc/RpcTest";

import * as Environment from "../../environment.ts";
import { makeMemoryCloud } from "../../testing.ts";
import * as CloudRpc from "../../user/rpc.ts";
import { scriptedModelSelection } from "../scriptedProvider.ts";

const identity = { environmentId: EnvironmentId.make("cloud-test"), label: "Cloud" };
const userId = "user_1";
const threadId = ThreadId.make("thread-1");

const scopes = [AuthOrchestrationReadScope, AuthOrchestrationOperateScope, AuthPreviewOperateScope];

/** One signed-in client of `user`, on its own session. */
const connect = (cloud: ReturnType<typeof makeMemoryCloud>, sid: string, user = userId) =>
  RpcTest.makeClient(CloudRpc.CloudRpcGroup).pipe(
    Effect.provide(
      Layer.mergeAll(
        CloudRpc.layerHandlers({ identity, userId: user, sid }),
        CloudRpc.layerScopeAuthorization(scopes),
      ).pipe(Layer.provide(cloud.layerFor(user))),
    ),
  );

type Rpc = Effect.Success<ReturnType<typeof connect>>;

const launch = (rpc: Rpc) =>
  rpc[ORCHESTRATION_V2_WS_METHODS.launchThread]({
    commandId: CommandId.make("launch"),
    threadId,
    projectId: Environment.SCRATCH_PROJECT_ID,
    title: "Read up",
    modelSelection: scriptedModelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    workspaceStrategy: { type: "root" },
    initialMessage: { messageId: MessageId.make("message-1"), text: "Hi", attachments: [] },
  });

/** The first `count` items the device receives, folded the way clients fold them. */
const firstItems = (rpc: Rpc, count: number) =>
  rpc[SIGNALBOX_BROWSING_WS_METHODS.subscribe]({ threadId }).pipe(
    Stream.take(count),
    Stream.runCollect,
  );

const fold = (items: ReadonlyArray<BrowsingStreamItem>) =>
  items.reduce(foldBrowsingItem, INITIAL_BROWSING_STATE);

describe("cloud thread browsing", () => {
  it.effect("advertises synced tabs", () =>
    Effect.gen(function* () {
      const rpc = yield* connect(makeMemoryCloud(), "desktop-session");
      const [item] = yield* rpc[WS_METHODS.subscribeServerConfig]({}).pipe(
        Stream.take(1),
        Stream.runCollect,
      );
      if (item?.type !== "snapshot") throw new Error("Expected a config snapshot");
      expect(item.config.environment.capabilities.threadBrowsing).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("shows tabs opened on desktop on the phone, with the active tab and position", () =>
    Effect.gen(function* () {
      const cloud = makeMemoryCloud();
      yield* cloud.userDirectory.forUser(userId).recordSignIn({ id: userId, email: "a@b.c" });
      const desktop = yield* connect(cloud, "desktop-session");
      const phone = yield* connect(cloud, "phone-session");
      yield* launch(desktop);
      yield* cloud.settle;

      // The desktop panel opens and reports tabs through the preview RPCs it already uses.
      const docs = yield* desktop[WS_METHODS.previewOpen]({
        threadId,
        url: "https://example.com/docs",
        runtime: "desktop",
      });
      expect(docs).toMatchObject({ threadId, runtime: "desktop" });
      yield* desktop[WS_METHODS.previewReportStatus]({
        threadId,
        tabId: docs.tabId,
        navStatus: { _tag: "Success", url: "https://example.com/docs", title: "Docs" },
        canGoBack: false,
        canGoForward: false,
      });
      const blog = yield* desktop[WS_METHODS.previewOpen]({
        threadId,
        url: "https://example.com/blog",
      });
      // Back to the docs, read halfway down.
      yield* desktop[SIGNALBOX_BROWSING_WS_METHODS.dispatch]({
        threadId,
        command: { _tag: "Activate", tabId: docs.tabId },
      });
      yield* desktop[SIGNALBOX_BROWSING_WS_METHODS.dispatch]({
        threadId,
        command: {
          _tag: "Position",
          tabId: docs.tabId,
          position: { scrollRatio: 0.5, textFragment: "Getting%20started" },
        },
      });

      const [snapshot] = yield* firstItems(phone, 1);
      const state = fold(snapshot === undefined ? [] : [snapshot]);
      expect(state.record.tabs.map((tab) => [tab.id, tab.url, tab.title])).toEqual([
        [docs.tabId, "https://example.com/docs", "Docs"],
        [blog.tabId, "https://example.com/blog", ""],
      ]);
      expect(state.record.activeTabId).toBe(docs.tabId);
      expect(state.record.tabs[0]?.position).toEqual({
        scrollRatio: 0.5,
        textFragment: "Getting%20started",
      });
      // The phone is not the desktop: what the desktop did is someone else's change to it.
      expect(state.you?._tag).toBe("Device");
      expect(state.record.tabs[0]?.positionBy).not.toEqual(state.you);
      // The record names devices, never their sessions.
      expect(JSON.stringify(state)).not.toContain("session");
    }).pipe(Effect.scoped),
  );

  it.effect("streams each change as one small event", () =>
    Effect.gen(function* () {
      const cloud = makeMemoryCloud();
      yield* cloud.userDirectory.forUser(userId).recordSignIn({ id: userId, email: "a@b.c" });
      const desktop = yield* connect(cloud, "desktop-session");
      const phone = yield* connect(cloud, "phone-session");
      yield* launch(desktop);
      yield* cloud.settle;
      const tab = yield* desktop[WS_METHODS.previewOpen]({ threadId, url: "https://a.example/" });

      const received = yield* Queue.unbounded<BrowsingStreamItem>();
      yield* Effect.forkScoped(
        Stream.runForEach(phone[SIGNALBOX_BROWSING_WS_METHODS.subscribe]({ threadId }), (item) =>
          Queue.offer(received, item),
        ),
      );
      // The snapshot means the phone is subscribed: everything after it arrives as events.
      const snapshot = yield* Queue.take(received);
      yield* desktop[WS_METHODS.previewReportStatus]({
        threadId,
        tabId: tab.tabId,
        navStatus: { _tag: "Success", url: "https://a.example/next", title: "Next" },
        canGoBack: true,
        canGoForward: false,
      });
      yield* desktop[WS_METHODS.previewClose]({ threadId, tabId: tab.tabId });
      const items = [snapshot, yield* Queue.take(received), yield* Queue.take(received)];

      expect(items.map((item) => (item._tag === "Event" ? item.event._tag : item._tag))).toEqual([
        "Snapshot",
        "TabNavigated",
        "TabClosed",
      ]);
      const navigated = items[1];
      expect(JSON.stringify(navigated).length).toBeLessThan(400);
      expect(fold(items).record).toMatchObject({ tabs: [], activeTabId: null });
      expect(fold(items).record.history.map((entry) => entry.url)).toEqual([
        "https://a.example/next",
        "https://a.example/",
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("opens a background tab without switching anyone to it", () =>
    Effect.gen(function* () {
      const cloud = makeMemoryCloud();
      yield* cloud.userDirectory.forUser(userId).recordSignIn({ id: userId, email: "a@b.c" });
      const desktop = yield* connect(cloud, "desktop-session");
      yield* launch(desktop);
      yield* cloud.settle;
      const reading = yield* desktop[WS_METHODS.previewOpen]({
        threadId,
        url: "https://a.example/",
      });
      // A cmd-click from the page: the panel asks for it without revealing it.
      yield* desktop[WS_METHODS.previewOpen]({
        threadId,
        url: "https://b.example/",
        reveal: false,
      });
      const [snapshot] = yield* firstItems(desktop, 1);
      const state = fold(snapshot === undefined ? [] : [snapshot]);
      expect(state.record.tabs).toHaveLength(2);
      expect(state.record.activeTabId).toBe(reading.tabId);
    }).pipe(Effect.scoped),
  );

  it.effect("navigates without carrying the old page's title, and closes every tab at once", () =>
    Effect.gen(function* () {
      const cloud = makeMemoryCloud();
      yield* cloud.userDirectory.forUser(userId).recordSignIn({ id: userId, email: "a@b.c" });
      const desktop = yield* connect(cloud, "desktop-session");
      yield* launch(desktop);
      yield* cloud.settle;
      const tab = yield* desktop[WS_METHODS.previewOpen]({ threadId, url: "https://a.example/" });
      yield* desktop[WS_METHODS.previewReportStatus]({
        threadId,
        tabId: tab.tabId,
        navStatus: { _tag: "Success", url: "https://a.example/", title: "Page A" },
        canGoBack: false,
        canGoForward: false,
      });
      const moved = yield* desktop[WS_METHODS.previewNavigate]({
        threadId,
        tabId: tab.tabId,
        url: "b.example",
      });
      expect(moved.navStatus).toEqual({ _tag: "Success", url: "https://b.example/", title: "" });
      yield* desktop[WS_METHODS.previewOpen]({ threadId, url: "https://c.example/" });
      yield* desktop[WS_METHODS.previewClose]({ threadId });
      const listed = yield* desktop[WS_METHODS.previewList]({ threadId });
      expect(listed.sessions).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("lists the record's tabs to the preview panel", () =>
    Effect.gen(function* () {
      const cloud = makeMemoryCloud();
      yield* cloud.userDirectory.forUser(userId).recordSignIn({ id: userId, email: "a@b.c" });
      const desktop = yield* connect(cloud, "desktop-session");
      const other = yield* connect(cloud, "other-desktop-session");
      yield* launch(desktop);
      yield* cloud.settle;
      const tab = yield* desktop[WS_METHODS.previewOpen]({ threadId, url: "https://a.example/" });
      const listed = yield* other[WS_METHODS.previewList]({ threadId });
      expect(listed.sessions.map((session) => session.tabId)).toEqual([tab.tabId]);
      expect(listed.sessions[0]?.navStatus).toEqual({
        _tag: "Success",
        url: "https://a.example/",
        title: "",
      });
    }).pipe(Effect.scoped),
  );

  it.effect("keeps another person out of the thread's tabs", () =>
    Effect.gen(function* () {
      const cloud = makeMemoryCloud();
      yield* cloud.userDirectory.forUser(userId).recordSignIn({ id: userId, email: "a@b.c" });
      yield* cloud.userDirectory.forUser("user_2").recordSignIn({ id: "user_2", email: "d@e.f" });
      const owner = yield* connect(cloud, "owner-session");
      const stranger = yield* connect(cloud, "stranger-session", "user_2");
      yield* launch(owner);
      yield* cloud.settle;
      const failure = yield* stranger[SIGNALBOX_BROWSING_WS_METHODS.dispatch]({
        threadId,
        command: { _tag: "Open", tabId: "sneaky", url: "https://evil.example/", activate: true },
      }).pipe(Effect.flip);
      expect(failure._tag).toBe("SignalboxBrowsingError");
      const listed = yield* owner[WS_METHODS.previewList]({ threadId });
      expect(listed.sessions).toEqual([]);
    }).pipe(Effect.scoped),
  );
});
