import type { BrowsingMember, BrowsingTab } from "@t3tools/contracts/signalboxBrowsing";
import { describe, expect, it } from "vite-plus/test";

import {
  captureIfReadScript,
  engineSentTo,
  engineVisited,
  initialEngineNavigation,
  navigationToFollow,
  OWN_VISIT_WINDOW_MS,
  positionToReport,
  positionToRestore,
  readerScrollTrackerScript,
} from "./browsingEngine";

const desktop: BrowsingMember = { _tag: "Device", userId: "u1", deviceId: "desktop" };
const phone: BrowsingMember = { _tag: "Device", userId: "u1", deviceId: "phone" };

const A = "https://example.com/a";
const B = "https://example.com/b";
const C = "https://example.com/c";

describe("navigationToFollow", () => {
  it("follows someone else moving the tab", () => {
    const navigation = engineVisited(initialEngineNavigation(A), A, 0);
    expect(
      navigationToFollow({ recordUrl: B, previousRecordUrl: A, navigation, now: 60_000 }),
    ).toBe(B);
  });

  it("doesn't reload the page the engine already shows or was just sent to", () => {
    const at = engineVisited(initialEngineNavigation(A), A, 0);
    expect(
      navigationToFollow({ recordUrl: A, previousRecordUrl: null, navigation: at, now: 1 }),
    ).toBeNull();
    const sent = engineSentTo(at, B);
    expect(
      navigationToFollow({ recordUrl: B, previousRecordUrl: A, navigation: sent, now: 1 }),
    ).toBeNull();
  });

  it("treats an engine's normalized address or a text directive as the same page", () => {
    const navigation = engineVisited(initialEngineNavigation(null), "https://example.com/", 0);
    expect(
      navigationToFollow({
        recordUrl: "https://example.com",
        previousRecordUrl: B,
        navigation,
        now: 60_000,
      }),
    ).toBeNull();
    expect(
      navigationToFollow({
        recordUrl: "https://example.com/#:~:text=Chapter",
        previousRecordUrl: B,
        navigation,
        now: 60_000,
      }),
    ).toBeNull();
  });

  it("never sends the engine to anything but a web page", () => {
    const navigation = engineVisited(initialEngineNavigation(A), A, 0);
    for (const recordUrl of ["about:blank", "javascript:alert(1)", "file:///etc/passwd"]) {
      expect(
        navigationToFollow({ recordUrl, previousRecordUrl: A, navigation, now: 60_000 }),
      ).toBeNull();
    }
  });

  it("only acts when the record's URL changed", () => {
    const navigation = engineVisited(initialEngineNavigation(A), A, 0);
    expect(
      navigationToFollow({ recordUrl: B, previousRecordUrl: B, navigation, now: 60_000 }),
    ).toBeNull();
    expect(
      navigationToFollow({ recordUrl: null, previousRecordUrl: B, navigation, now: 60_000 }),
    ).toBeNull();
  });

  it("ignores the echo of its own older report while it moved on", () => {
    let navigation = engineVisited(initialEngineNavigation(A), A, 0);
    navigation = engineVisited(navigation, B, 100);
    navigation = engineVisited(navigation, C, 200);
    // B, reported by this engine, lands in the record after it reached C.
    expect(navigationToFollow({ recordUrl: B, previousRecordUrl: A, navigation, now: 400 })).toBe(
      null,
    );
    // Much later someone else going back to B is a real move.
    expect(
      navigationToFollow({
        recordUrl: B,
        previousRecordUrl: C,
        navigation,
        now: 200 + OWN_VISIT_WINDOW_MS + 1,
      }),
    ).toBe(B);
  });

  it("doesn't fight a redirect another device's engine doesn't get", () => {
    // Sent to the desktop page, this engine lands on the mobile one (and reports it).
    let navigation = engineSentTo(engineVisited(initialEngineNavigation(A), A, 0), B);
    navigation = engineVisited(navigation, "https://m.example.com/b", 100);
    expect(navigation.landings).toEqual([{ sentTo: B, landed: "https://m.example.com/b" }]);
    // A late report of the page it left doesn't count as where it landed.
    expect(engineVisited(engineSentTo(navigation, C), "https://m.example.com/b", 200).sentTo).toBe(
      C,
    );
    // The other device redirects back and reports B again: going there lands here again.
    expect(
      navigationToFollow({
        recordUrl: B,
        previousRecordUrl: "https://m.example.com/b",
        navigation,
        now: 60_000,
      }),
    ).toBeNull();
  });
});

const tab = (overrides: Partial<BrowsingTab> = {}): BrowsingTab => ({
  id: "a",
  url: A,
  title: "A",
  orderKey: "a0",
  openedBy: desktop,
  updatedAt: "2026-10-16T10:00:00.000Z",
  ...overrides,
});

describe("positionToRestore", () => {
  const position = { scrollRatio: 0.5, textFragment: "Chapter%202" };

  it("restores where someone else read the same page to", () => {
    expect(positionToRestore(tab({ position, positionBy: phone }), desktop, A)).toEqual(position);
  });

  it("skips its own report, another page, the page top and no position", () => {
    expect(positionToRestore(tab({ position, positionBy: desktop }), desktop, A)).toBeNull();
    expect(positionToRestore(tab({ position, positionBy: phone }), desktop, B)).toBeNull();
    expect(
      positionToRestore(tab({ position: { scrollRatio: 0 }, positionBy: phone }), desktop, A),
    ).toBeNull();
    expect(positionToRestore(tab(), desktop, A)).toBeNull();
    expect(positionToRestore(tab({ position, positionBy: phone }), null, A)).toBeNull();
  });
});

describe("page scripts", () => {
  it("are self-contained expressions an engine can evaluate", () => {
    expect(() => new Function(`return (${readerScrollTrackerScript});`)).not.toThrow();
    expect(() => new Function(`return (${captureIfReadScript});`)).not.toThrow();
  });
});

describe("positionToReport", () => {
  it("reports a real move on the page the record has", () => {
    expect(positionToReport(tab(), A, { scrollRatio: 0.3 })).toEqual({
      _tag: "Position",
      tabId: "a",
      position: { scrollRatio: 0.3 },
    });
  });

  it("matches the record's page however the engine spells it", () => {
    expect(
      positionToReport(tab({ url: "https://example.com" }), "https://example.com/", {
        scrollRatio: 0.3,
      }),
    ).not.toBeNull();
  });

  it("skips the page top of a fresh page, near-identical positions and other pages", () => {
    expect(positionToReport(tab(), A, { scrollRatio: 0 })).toBeNull();
    expect(
      positionToReport(tab({ position: { scrollRatio: 0.3 } }), A, { scrollRatio: 0.305 }),
    ).toBeNull();
    expect(positionToReport(tab(), B, { scrollRatio: 0.3 })).toBeNull();
    expect(positionToReport(tab(), A, null)).toBeNull();
    expect(positionToReport(undefined, A, { scrollRatio: 0.3 })).toBeNull();
  });

  it("reports scrolling back to the top once it had a position", () => {
    expect(
      positionToReport(tab({ position: { scrollRatio: 0.3 } }), A, { scrollRatio: 0 }),
    ).toEqual({ _tag: "Position", tabId: "a", position: { scrollRatio: 0 } });
  });
});
