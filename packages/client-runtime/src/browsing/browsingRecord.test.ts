import {
  type BrowsingEvent,
  type BrowsingMember,
  type BrowsingTab,
  EMPTY_BROWSING_RECORD,
} from "@t3tools/contracts/signalboxBrowsing";
import { describe, expect, it } from "@effect/vitest";

import { ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  activeBrowsingTab,
  applyBrowsingEvent,
  browsingShareMenu,
  browsingSharingNote,
  browsingTabHost,
  browsingTabLabel,
  browsingTabSnapshot,
  reportableUrl,
  samePageUrl,
  foldBrowsingItem,
  INITIAL_BROWSING_STATE,
  isOwnedBy,
  ownerOf,
  isOwnChange,
} from "./browsingRecord.ts";

const desktop: BrowsingMember = { _tag: "Device", userId: "u1", deviceId: "desktop" };
const phone: BrowsingMember = { _tag: "Device", userId: "u1", deviceId: "phone" };

const tab = (id: string, orderKey: string, url: string | null = null): BrowsingTab => ({
  id,
  url,
  title: "",
  orderKey,
  owner: { _tag: "Person", userId: "u1" },
  updatedAt: "2026-10-16T10:00:00.000Z",
});

let sequence = 0;
const at = "2026-10-16T10:00:01.000Z";
const opened = (t: BrowsingTab): BrowsingEvent => ({
  _tag: "TabOpened",
  sequence: ++sequence,
  at,
  by: desktop,
  tab: t,
});

describe("applyBrowsingEvent", () => {
  it("keeps tabs in order-key order whatever order they open in", () => {
    const record = [opened(tab("b", "a2")), opened(tab("a", "a1")), opened(tab("c", "a3"))].reduce(
      applyBrowsingEvent,
      EMPTY_BROWSING_RECORD,
    );
    expect(record.tabs.map((t) => t.id)).toEqual(["a", "b", "c"]);
  });

  it("records a navigation in the tab and at the top of history", () => {
    const record = [
      opened(tab("a", "a1", "https://example.com/")),
      {
        _tag: "TabNavigated",
        sequence: ++sequence,
        at,
        by: phone,
        tabId: "a",
        url: "https://example.com/docs",
        title: "Docs",
      } satisfies BrowsingEvent,
    ].reduce(applyBrowsingEvent, EMPTY_BROWSING_RECORD);
    expect(record.tabs[0]).toMatchObject({ url: "https://example.com/docs", title: "Docs" });
    expect(record.history.map((entry) => entry.url)).toEqual([
      "https://example.com/docs",
      "https://example.com/",
    ]);
  });

  it("updates a title in place instead of adding history for the same page", () => {
    const record = [
      opened(tab("a", "a1", "https://example.com/")),
      {
        _tag: "TabNavigated",
        sequence: ++sequence,
        at,
        by: desktop,
        tabId: "a",
        url: "https://example.com/",
        title: "Example",
      } satisfies BrowsingEvent,
    ].reduce(applyBrowsingEvent, EMPTY_BROWSING_RECORD);
    expect(record.history).toEqual([{ url: "https://example.com/", title: "Example", at }]);
  });

  it("moves, activates, positions and closes tabs", () => {
    const record = [
      opened(tab("a", "a1")),
      opened(tab("b", "a2")),
      { _tag: "TabMoved", sequence: ++sequence, at, by: desktop, tabId: "b", orderKey: "a0" },
      { _tag: "TabActivated", sequence: ++sequence, at, by: desktop, tabId: "b" },
      {
        _tag: "TabPositioned",
        sequence: ++sequence,
        at,
        by: phone,
        tabId: "b",
        position: { scrollRatio: 0.5, textFragment: "Chapter%202" },
      },
      { _tag: "TabClosed", sequence: ++sequence, at, by: desktop, tabId: "a" },
    ] satisfies ReadonlyArray<BrowsingEvent>;
    const result = record.reduce(applyBrowsingEvent, EMPTY_BROWSING_RECORD);
    expect(result.tabs.map((t) => t.id)).toEqual(["b"]);
    expect(result.activeTabId).toBe("b");
    expect(result.tabs[0]?.position).toEqual({ scrollRatio: 0.5, textFragment: "Chapter%202" });
    expect(result.tabs[0]?.positionBy).toEqual(phone);
  });

  it("ignores changes to a tab it doesn't have", () => {
    const record = applyBrowsingEvent(EMPTY_BROWSING_RECORD, {
      _tag: "TabNavigated",
      sequence: ++sequence,
      at,
      by: desktop,
      tabId: "gone",
      url: "https://example.com/",
      title: "",
    });
    expect(record).toBe(EMPTY_BROWSING_RECORD);
  });
});

describe("foldBrowsingItem", () => {
  it("starts over from each snapshot and skips events it already has", () => {
    const snapshot = foldBrowsingItem(INITIAL_BROWSING_STATE, {
      _tag: "Snapshot",
      sequence: 5,
      record: { tabs: [tab("a", "a1")], activeTabId: "a", history: [] },
      you: phone,
    });
    expect(snapshot.you).toEqual(phone);
    const stale = foldBrowsingItem(snapshot, {
      _tag: "Event",
      event: { _tag: "TabClosed", sequence: 5, at, by: desktop, tabId: "a" },
    });
    expect(stale).toBe(snapshot);
    const next = foldBrowsingItem(snapshot, {
      _tag: "Event",
      event: { _tag: "TabClosed", sequence: 6, at, by: desktop, tabId: "a" },
    });
    expect(next.sequence).toBe(6);
    expect(next.record.tabs).toEqual([]);
  });
});

describe("helpers", () => {
  it("finds the active tab, falling back to the first", () => {
    const record = { tabs: [tab("a", "a1"), tab("b", "a2")], activeTabId: null, history: [] };
    expect(activeBrowsingTab(record)?.id).toBe("a");
    expect(activeBrowsingTab({ ...record, activeTabId: "b" })?.id).toBe("b");
    expect(activeBrowsingTab(EMPTY_BROWSING_RECORD)).toBeNull();
  });

  it("tells a device its own changes apart", () => {
    expect(isOwnChange(desktop, desktop)).toBe(true);
    expect(isOwnChange(phone, desktop)).toBe(false);
    expect(isOwnChange({ _tag: "Agent", agentId: "kernel" }, desktop)).toBe(false);
    expect(isOwnChange(undefined, desktop)).toBe(false);
    expect(isOwnChange(desktop, null)).toBe(false);
  });
});

describe("pages", () => {
  it("treats engine normalization and text directives as the same page", () => {
    expect(samePageUrl("https://example.com", "https://example.com/")).toBe(true);
    expect(samePageUrl("https://example.com/a#:~:text=Hi", "https://example.com/a")).toBe(true);
    expect(samePageUrl("https://example.com/a", "https://example.com/b")).toBe(false);
    expect(samePageUrl(null, "https://example.com/")).toBe(false);
  });

  it("only reports web pages", () => {
    expect(reportableUrl("https://example.com/")).toBe("https://example.com/");
    expect(reportableUrl("about:blank")).toBeNull();
    expect(reportableUrl("data:text/html,hi")).toBeNull();
    expect(reportableUrl(undefined)).toBeNull();
  });

  it("names a tab's host", () => {
    expect(browsingTabHost("https://docs.example.com/a")).toBe("docs.example.com");
    expect(browsingTabHost("not a url")).toBeNull();
    expect(browsingTabHost(null)).toBeNull();
    expect(browsingTabLabel({ title: "", url: "https://docs.example.com/a" })).toBe(
      "docs.example.com",
    );
  });

  it("shows a record tab to the browser panel as a session", () => {
    const opened = { ...tab("a", "a1", "https://example.com/"), title: "Example" };
    expect(browsingTabSnapshot(ThreadId.make("t"), opened)).toEqual({
      threadId: "t",
      tabId: "a",
      navStatus: { _tag: "Success", url: "https://example.com/", title: "Example" },
      canGoBack: false,
      canGoForward: false,
      runtime: "desktop",
      updatedAt: opened.updatedAt,
    });
    expect(browsingTabSnapshot(ThreadId.make("t"), tab("b", "a2")).navStatus).toEqual({
      _tag: "Idle",
    });
  });
});

describe("ownership", () => {
  it("knows who owns a tab", () => {
    const person = { _tag: "Person", userId: "u1" } as const;
    expect(ownerOf(desktop)).toEqual(person);
    expect(ownerOf({ _tag: "Agent", agentId: "k" })).toEqual({ _tag: "Agent", agentId: "k" });
    expect(isOwnedBy({ owner: person }, phone)).toBe(true);
    expect(isOwnedBy({ owner: person }, { _tag: "Device", userId: "u2", deviceId: "x" })).toBe(
      false,
    );
    expect(isOwnedBy({ owner: person }, { _tag: "Agent", agentId: "k" })).toBe(false);
    expect(isOwnedBy({ owner: person }, null)).toBe(false);
  });
});

describe("browsingSharingNote", () => {
  const until = "2026-10-19T10:00:00.000Z";
  const sharing = (end: string | null) => ({
    sharing: {
      audience: "Thread" as const,
      until: end,
      since: "2026-10-16T10:00:00.000Z",
      by: { _tag: "Device" as const, userId: "u1", deviceId: "d" },
    },
  });
  const now = Date.parse("2026-10-17T10:00:00.000Z");
  const day = (at: number) => DateTime.formatIso(DateTime.makeUnsafe(at)).slice(0, 10);

  it("says who can see the tab and until when", () => {
    expect(browsingSharingNote({}, now)).toBe("Private: only you can see this tab.");
    expect(browsingSharingNote(sharing(until), now, day)).toBe(
      "Anyone in this thread can see it until 2026-10-19.",
    );
    expect(browsingSharingNote(sharing(null), now)).toBe(
      "Anyone in this thread can see it until you stop sharing.",
    );
  });

  it("reads a share whose end passed as private", () => {
    expect(browsingSharingNote(sharing(until), Date.parse(until))).toBe(
      "Private: only you can see this tab.",
    );
  });
});

describe("browsingShareMenu", () => {
  it("offers sharing a private tab, and keeping or stopping a shared one", () => {
    const now = Date.parse("2026-10-17T10:00:00.000Z");
    const closed = browsingShareMenu({ id: "a" }, now);
    expect(closed).toMatchObject({ shared: false, label: "Share with this thread", stop: null });
    expect(closed.choices.map((choice) => choice.title)).toEqual([
      "Share until I stop",
      "Share for a day",
      "Share for 3 days",
      "Share for a week",
    ]);
    expect(closed.choices[2]?.command).toEqual({
      _tag: "Share",
      tabId: "a",
      audience: "Thread",
      days: 3,
    });
    const open = browsingShareMenu(
      {
        id: "a",
        sharing: {
          audience: "Thread",
          until: null,
          since: "2026-10-16T10:00:00.000Z",
          by: { _tag: "Device", userId: "u1", deviceId: "d" },
        },
      },
      now,
    );
    expect(open.choices[0]?.title).toBe("Keep sharing until I stop");
    expect(open.stop).toEqual({ _tag: "Unshare", tabId: "a" });
  });
});
