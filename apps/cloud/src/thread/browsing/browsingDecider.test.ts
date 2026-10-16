import { applyBrowsingEvent } from "@t3tools/client-runtime/browsing";
import {
  BROWSING_MAX_TABS,
  type BrowsingCommand,
  type BrowsingMember,
  type BrowsingRecord,
  EMPTY_BROWSING_RECORD,
} from "@t3tools/contracts/signalboxBrowsing";
import { describe, expect, it } from "@effect/vitest";

import { decideBrowsing } from "./browsingDecider.ts";

const desktop: BrowsingMember = { _tag: "Device", userId: "u1", deviceId: "desktop" };
const at = "2026-10-16T10:00:00.000Z";

/** Applies commands in order the way the thread does, returning the record and every event. */
const run = (commands: ReadonlyArray<BrowsingCommand>, start = EMPTY_BROWSING_RECORD) => {
  let record: BrowsingRecord = start;
  let sequence = 0;
  const decisions = commands.map((command) => {
    const decision = decideBrowsing(record, command, { by: desktop, at, sequence });
    if (decision._tag === "Events") {
      for (const event of decision.events) record = applyBrowsingEvent(record, event);
      sequence += decision.events.length;
    }
    return decision;
  });
  return { record, decisions };
};

const open = (tabId: string, extra: Partial<Extract<BrowsingCommand, { _tag: "Open" }>> = {}) =>
  ({ _tag: "Open", tabId, activate: true, ...extra }) satisfies BrowsingCommand;

describe("decideBrowsing", () => {
  it("opens tabs at the end and activates them", () => {
    const { record, decisions } = run([open("a", { url: "https://example.com/" }), open("b")]);
    expect(record.tabs.map((tab) => tab.id)).toEqual(["a", "b"]);
    expect(record.activeTabId).toBe("b");
    expect(record.tabs[0]).toMatchObject({ url: "https://example.com/", openedBy: desktop });
    expect(record.tabs[1]?.url).toBeNull();
    const first = decisions[0];
    expect(first?._tag === "Events" && first.events.map((event) => event.sequence)).toEqual([1, 2]);
  });

  it("lands a retried open once", () => {
    const { record, decisions } = run([open("a"), open("a")]);
    expect(record.tabs).toHaveLength(1);
    expect(decisions[1]).toEqual({ _tag: "Events", events: [] });
  });

  it("opens right after another tab", () => {
    const { record } = run([open("a"), open("b"), open("c", { afterTabId: "a" })]);
    expect(record.tabs.map((tab) => tab.id)).toEqual(["a", "c", "b"]);
  });

  it("moves a tab with one small event", () => {
    const { record, decisions } = run([
      open("a"),
      open("b"),
      open("c"),
      { _tag: "Move", tabId: "c", beforeTabId: "a" },
      { _tag: "Move", tabId: "a", beforeTabId: null },
    ]);
    expect(record.tabs.map((tab) => tab.id)).toEqual(["c", "b", "a"]);
    const move = decisions[3];
    expect(move?._tag === "Events" && move.events.map((event) => event._tag)).toEqual(["TabMoved"]);
  });

  it("changes nothing for a move to where the tab already is", () => {
    const { decisions } = run([
      open("a"),
      open("b"),
      { _tag: "Move", tabId: "a", beforeTabId: "b" },
      { _tag: "Move", tabId: "b", beforeTabId: null },
    ]);
    expect(decisions.slice(2)).toEqual([
      { _tag: "Events", events: [] },
      { _tag: "Events", events: [] },
    ]);
  });

  it("activates the next tab when the active one closes, like Chrome", () => {
    const { record } = run([
      open("a"),
      open("b"),
      open("c"),
      { _tag: "Activate", tabId: "b" },
      { _tag: "Close", tabId: "b" },
    ]);
    expect(record.tabs.map((tab) => tab.id)).toEqual(["a", "c"]);
    expect(record.activeTabId).toBe("c");
    const last = run([open("a"), open("b"), { _tag: "Close", tabId: "b" }]).record;
    expect(last.activeTabId).toBe("a");
    expect(run([open("a"), { _tag: "Close", tabId: "a" }]).record.activeTabId).toBeNull();
  });

  it("closes every tab at once", () => {
    const { record, decisions } = run([
      open("a"),
      open("b"),
      { _tag: "CloseAll" },
      { _tag: "CloseAll" },
    ]);
    expect(record).toMatchObject({ tabs: [], activeTabId: null });
    const closing = decisions[2];
    expect(closing?._tag === "Events" && closing.events.map((event) => event._tag)).toEqual([
      "TabClosed",
      "TabClosed",
    ]);
    expect(decisions[3]).toEqual({ _tag: "Events", events: [] });
  });

  it("skips navigations and positions that change nothing", () => {
    const { decisions } = run([
      open("a", { url: "https://example.com/", title: "Example" }),
      { _tag: "Navigate", tabId: "a", url: "https://example.com/", title: "Example" },
      { _tag: "Position", tabId: "a", position: { scrollRatio: 0.25 } },
      { _tag: "Position", tabId: "a", position: { scrollRatio: 0.25 } },
    ]);
    expect(decisions[1]).toEqual({ _tag: "Events", events: [] });
    expect(decisions[3]).toEqual({ _tag: "Events", events: [] });
  });

  it("ignores late reports for a tab that is already closed", () => {
    const { decisions } = run([
      { _tag: "Navigate", tabId: "gone", url: "https://example.com/", title: "" },
      { _tag: "Position", tabId: "gone", position: { scrollRatio: 0.5 } },
      { _tag: "Activate", tabId: "gone" },
      { _tag: "Close", tabId: "gone" },
      { _tag: "Move", tabId: "gone", beforeTabId: null },
    ]);
    for (const decision of decisions) expect(decision).toEqual({ _tag: "Events", events: [] });
  });

  it("refuses a tab past the limit", () => {
    const full = run(Array.from({ length: BROWSING_MAX_TABS }, (_, index) => open(`t${index}`)));
    expect(full.record.tabs).toHaveLength(BROWSING_MAX_TABS);
    expect(decideBrowsing(full.record, open("one-more"), { by: desktop, at, sequence: 0 })).toEqual(
      {
        _tag: "Rejected",
        reason: `A thread keeps up to ${BROWSING_MAX_TABS} tabs. Close one first.`,
      },
    );
  });
});
