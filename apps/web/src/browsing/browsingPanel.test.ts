import type { BrowsingState } from "@t3tools/client-runtime/browsing";
import { type PreviewSessionSnapshot, ThreadId } from "@t3tools/contracts";
import type { BrowsingMember, BrowsingTab } from "@t3tools/contracts/signalboxBrowsing";
import { describe, expect, it } from "vite-plus/test";

import {
  browserSurfaceChange,
  browserSurfaceMoves,
  browserSurfaceTabIds,
  browsingPreviewList,
  localActivation,
  localIntentHeld,
  localIntentSettled,
  localIntentStarted,
  NO_LOCAL_INTENT,
  remoteActivation,
  samePanelRecord,
  shownBrowsingTabId,
  tabMovesForLocalOrder,
} from "./browsingPanel";

const desktop: BrowsingMember = { _tag: "Device", userId: "u1", deviceId: "desktop" };

const tab = (id: string, url: string | null = `https://example.com/${id}`): BrowsingTab => ({
  id,
  url,
  title: url === null ? "" : `Page ${id}`,
  orderKey: id,
  owner: { _tag: "Person", userId: "u1" },
  updatedAt: "2026-10-16T10:00:00.000Z",
});
const agentTab = (id: string): BrowsingTab => ({
  ...tab(id),
  owner: { _tag: "Agent", agentId: "kernel" },
});
const otherPersonTab = (id: string): BrowsingTab => ({
  ...tab(id),
  owner: { _tag: "Person", userId: "u2" },
});

const state = (
  tabs: ReadonlyArray<BrowsingTab>,
  activeTabId: string | null,
  sequence = 5,
): BrowsingState => ({ you: desktop, sequence, record: { tabs, activeTabId, history: [] } });

describe("browsingPreviewList", () => {
  it("lists record tabs in order and keeps what only this device set", () => {
    const local: PreviewSessionSnapshot = {
      threadId: "t1",
      tabId: "b",
      navStatus: { _tag: "Success", url: "https://example.com/old", title: "Old" },
      canGoBack: true,
      canGoForward: false,
      viewport: { _tag: "fill" },
      colorScheme: "dark",
      zoomFactor: 1.25,
      profileId: "work",
      runtime: "desktop",
      updatedAt: "2026-10-16T11:00:00.000Z",
    };
    const list = browsingPreviewList(ThreadId.make("t1"), state([tab("a"), tab("b")], "a"), {
      b: local,
    });
    expect(list.sessions.map((session) => session.tabId)).toEqual(["a", "b"]);
    expect(list.sessions[1]).toMatchObject({
      navStatus: { _tag: "Success", url: "https://example.com/b", title: "Page b" },
      canGoBack: true,
      colorScheme: "dark",
      zoomFactor: 1.25,
      profileId: "work",
      // Not older than the local session, so the panel's reconcile takes the record's URL.
      updatedAt: "2026-10-16T11:00:00.000Z",
    });
    expect(list.sessions[0]).toMatchObject({ canGoBack: false, runtime: "desktop" });
    expect(list).toMatchObject({ serverEpoch: "thread-browsing", revision: 5 });
  });

  it("keeps this device's failed load of the same page, and an untouched tab idle", () => {
    const failed: PreviewSessionSnapshot = {
      threadId: "t1",
      tabId: "a",
      navStatus: {
        _tag: "LoadFailed",
        url: "https://example.com/a",
        title: "",
        code: -105,
        description: "Name not resolved",
      },
      canGoBack: false,
      canGoForward: false,
      updatedAt: "2026-10-16T09:00:00.000Z",
    };
    const list = browsingPreviewList(ThreadId.make("t1"), state([tab("a"), tab("n", null)], "a"), {
      a: failed,
    });
    expect(list.sessions[0]?.navStatus._tag).toBe("LoadFailed");
    expect(list.sessions[1]?.navStatus).toEqual({ _tag: "Idle" });
    const moved = browsingPreviewList(
      ThreadId.make("t1"),
      state([tab("a", "https://example.com/next")], "a"),
      {
        a: failed,
      },
    );
    expect(moved.sessions[0]?.navStatus._tag).toBe("Success");
  });

  it("leaves out tabs someone else drives: an agent's, another person's", () => {
    const list = browsingPreviewList(
      ThreadId.make("t1"),
      state([tab("a"), agentTab("k"), otherPersonTab("o"), tab("b")], "k"),
      {},
    );
    expect(list.sessions.map((session) => session.tabId)).toEqual(["a", "b"]);
  });

  it("ignores positions when deciding whether the panel changed", () => {
    const before = state([tab("a"), tab("b")], "a");
    const positioned = state(
      [
        { ...tab("a"), position: { scrollRatio: 0.4 }, updatedAt: "2026-10-16T12:00:00.000Z" },
        tab("b"),
      ],
      "a",
      6,
    );
    expect(samePanelRecord(before, positioned)).toBe(true);
    expect(samePanelRecord(before, state([tab("b"), tab("a")], "a"))).toBe(false);
    expect(samePanelRecord(before, state([tab("a"), tab("b")], "b"))).toBe(false);
    expect(samePanelRecord(before, state([tab("a"), { ...tab("b"), title: "New" }], "a"))).toBe(
      false,
    );
    expect(samePanelRecord(before, state([tab("a")], "a"))).toBe(false);
  });
});

describe("activation", () => {
  const record = state([tab("a"), tab("b")], "b");

  it("follows someone else's activation", () => {
    expect(remoteActivation(record, "a", NO_LOCAL_INTENT)).toBe("b");
    expect(remoteActivation(record, "b", NO_LOCAL_INTENT)).toBeNull();
  });

  it("treats a record with no active tab as showing its first", () => {
    expect(remoteActivation(state([tab("a"), tab("b")], null), "a", NO_LOCAL_INTENT)).toBeNull();
    expect(localActivation(state([tab("a"), tab("b")], null), "a")).toBeNull();
  });

  it("holds this device's own switch until the record caught up with it", () => {
    const sent = localIntentStarted(NO_LOCAL_INTENT);
    // The echo of an earlier switch arrives while the latest one is in flight.
    expect(remoteActivation(record, "a", sent)).toBeNull();
    const landed = localIntentSettled(sent, 7);
    expect(localIntentHeld(landed, 6)).toBe(true);
    expect(remoteActivation(record, "a", landed)).toBeNull();
    expect(remoteActivation({ ...record, sequence: 7 }, "a", landed)).toBe("b");
    // A failed command releases the hold without moving it.
    expect(localIntentSettled(sent, null)).toEqual(NO_LOCAL_INTENT);
  });

  it("loads nothing here when the thread switches to a tab this device doesn't drive", () => {
    const toAgent = state([tab("a"), agentTab("k")], "k");
    expect(remoteActivation(toAgent, "a", NO_LOCAL_INTENT)).toBeNull();
    // This device's own switch away from the agent's tab still goes to the record.
    expect(localActivation(toAgent, "a")).toEqual({ _tag: "Activate", tabId: "a" });
  });

  it("shows the thread's tab when it's one this device can't load, else this device's", () => {
    expect(shownBrowsingTabId(state([tab("a"), agentTab("k")], "k"), "a")).toBe("k");
    // This device's own switch shows at once, ahead of the record.
    expect(shownBrowsingTabId(state([tab("a"), tab("b")], "a"), "b")).toBe("b");
    expect(shownBrowsingTabId(null, "b")).toBe("b");
  });

  it("does nothing before the first snapshot", () => {
    const empty: BrowsingState = { ...record, you: null };
    expect(remoteActivation(empty, "a", NO_LOCAL_INTENT)).toBeNull();
    expect(localActivation(empty, "a")).toBeNull();
  });

  it("sends a local switch the record doesn't have yet, and only for its tabs", () => {
    expect(localActivation(record, "a")).toEqual({ _tag: "Activate", tabId: "a" });
    expect(localActivation(record, "b")).toBeNull();
    expect(localActivation(record, "gone")).toBeNull();
    expect(localActivation(record, null)).toBeNull();
  });
});

const browser = (tabId: string) => ({
  id: `browser:${tabId}`,
  kind: "preview",
  resourceId: tabId,
});
const terminal = { id: "terminal:1", kind: "terminal", resourceId: "1" };

describe("browserSurfaceMoves", () => {
  const apply = (
    surfaces: ReadonlyArray<{ id: string; kind: string; resourceId: string | null }>,
    recordTabIds: ReadonlyArray<string>,
  ) => {
    const result = surfaces.slice();
    for (const move of browserSurfaceMoves(surfaces, recordTabIds)) {
      const from = result.findIndex((surface) => surface.id === move.surfaceId);
      result.splice(move.toIndex, 0, ...result.splice(from, 1));
    }
    return result.map((surface) => surface.id);
  };

  it("puts browser tabs in record order, leaving other tabs where they are", () => {
    expect(apply([browser("c"), terminal, browser("a"), browser("b")], ["a", "b", "c"])).toEqual([
      "browser:a",
      "terminal:1",
      "browser:b",
      "browser:c",
    ]);
  });

  it("changes nothing when the order already matches", () => {
    expect(browserSurfaceMoves([browser("a"), terminal, browser("b")], ["a", "b"])).toEqual([]);
  });

  it("leaves tabs the record doesn't have alone", () => {
    const fresh = { id: "browser:new", kind: "preview", resourceId: null };
    expect(apply([browser("b"), fresh, browser("x"), browser("a")], ["a", "b"])).toEqual([
      "browser:a",
      "browser:new",
      "browser:x",
      "browser:b",
    ]);
  });

  it("tells a drag from tabs coming and going", () => {
    const strip = [browser("a"), terminal, browser("b")];
    expect(browserSurfaceChange(strip, [browser("b"), terminal, browser("a")])).toBe("order");
    // Moving a terminal past the browser tabs leaves their order alone.
    expect(browserSurfaceChange(strip, [terminal, browser("a"), browser("b")])).toBeNull();
    expect(browserSurfaceChange(strip, [browser("a"), terminal])).toBe("set");
    expect(browserSurfaceChange(strip, [...strip, browser("c")])).toBe("set");
  });

  it("reads the tab strip's browser tabs in order", () => {
    expect(browserSurfaceTabIds([browser("b"), terminal, browser("a")])).toEqual(["b", "a"]);
  });
});

describe("tabMovesForLocalOrder", () => {
  /** Applies the commands the way the record does. */
  const replay = (record: ReadonlyArray<string>, local: ReadonlyArray<string>) => {
    const order = record.slice();
    for (const command of tabMovesForLocalOrder(record, local)) {
      if (command._tag !== "Move") throw new Error("expected moves");
      order.splice(order.indexOf(command.tabId), 1);
      const before =
        command.beforeTabId === null ? order.length : order.indexOf(command.beforeTabId);
      order.splice(before, 0, command.tabId);
    }
    return order;
  };

  it("turns a drag into one move", () => {
    expect(tabMovesForLocalOrder(["a", "b", "c", "d"], ["a", "c", "b", "d"])).toHaveLength(1);
    expect(tabMovesForLocalOrder(["a", "b", "c"], ["b", "c", "a"])).toEqual([
      { _tag: "Move", tabId: "a", beforeTabId: null },
    ]);
    expect(tabMovesForLocalOrder(["a", "b", "c"], ["c", "a", "b"])).toEqual([
      { _tag: "Move", tabId: "c", beforeTabId: "a" },
    ]);
  });

  it("sends nothing when the order matches", () => {
    expect(tabMovesForLocalOrder(["a", "b"], ["a", "b"])).toEqual([]);
  });

  it("reaches any order", () => {
    const local = ["e", "c", "a", "d", "b"];
    expect(replay(["a", "b", "c", "d", "e"], local)).toEqual(local);
  });

  it("only orders the tabs both sides have", () => {
    expect(tabMovesForLocalOrder(["a", "x", "b"], ["b", "a", "new"])).toHaveLength(1);
  });
});
