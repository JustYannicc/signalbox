import type {
  BrowsingMember,
  BrowsingRecord,
  BrowsingTab,
} from "@t3tools/contracts/signalboxBrowsing";
import { describe, expect, it } from "vite-plus/test";

import {
  browsingPageScript,
  browsingTabEngine,
  browsingTabSubtitle,
  navigateCommand,
  parsePageMessage,
  positionCommand,
  positionToRestore,
  settleReports,
  shownBrowsingTab,
  urlToFollow,
} from "./syncedBrowsing";

const desktop: BrowsingMember = { _tag: "Device", userId: "u1", deviceId: "desktop" };
const phone: BrowsingMember = { _tag: "Device", userId: "u1", deviceId: "phone" };

const agentOwner = { _tag: "Agent", agentId: "kernel" } as const;
const teammateOwner = { _tag: "Person", userId: "u2" } as const;

const tab = (overrides: Partial<BrowsingTab> = {}): BrowsingTab => ({
  id: "tab_a",
  url: "https://example.com/docs",
  title: "Docs",
  orderKey: "a1",
  owner: { _tag: "Person", userId: "u1" },
  updatedAt: "2026-10-16T10:00:00.000Z",
  ...overrides,
});

describe("navigateCommand", () => {
  it("reports a page the record doesn't have", () => {
    expect(
      navigateCommand(tab(), phone, { url: "https://example.com/blog", title: " Blog " }, null),
    ).toEqual({ _tag: "Navigate", tabId: "tab_a", url: "https://example.com/blog", title: "Blog" });
  });

  it("reports the first page of a new tab", () => {
    expect(
      navigateCommand(
        tab({ url: null, title: "" }),
        phone,
        { url: "https://example.com/", title: "" },
        null,
      ),
    ).toMatchObject({ _tag: "Navigate", url: "https://example.com/" });
  });

  it("reports a title that arrived after the page", () => {
    expect(
      navigateCommand(
        tab({ title: "" }),
        phone,
        { url: "https://example.com/docs", title: "Docs" },
        null,
      ),
    ).toMatchObject({ title: "Docs" });
  });

  it("skips what the record already says, including after normalization", () => {
    expect(
      navigateCommand(
        tab({ url: "https://example.com", title: "Home" }),
        phone,
        { url: "https://example.com/", title: "Home" },
        null,
      ),
    ).toBeNull();
  });

  it("never blanks a known title for the same page", () => {
    expect(
      navigateCommand(tab(), phone, { url: "https://example.com/docs", title: "" }, null),
    ).toBeNull();
  });

  it("skips its own report while that report is still on the way", () => {
    const page = { url: "https://example.com/blog", title: "Blog" };
    expect(navigateCommand(tab(), phone, page, page)).toBeNull();
  });

  it("reports going back to the record's page while its own report is on the way", () => {
    const reported = { url: "https://example.com/blog", title: "Blog" };
    expect(
      navigateCommand(tab(), phone, { url: "https://example.com/docs", title: "Docs" }, reported),
    ).toMatchObject({ url: "https://example.com/docs" });
  });

  it("skips pages that aren't on the web", () => {
    for (const url of ["about:blank", "data:text/html,hi", "file:///etc/hosts", "", null]) {
      expect(navigateCommand(tab(), phone, { url, title: "x" }, null)).toBeNull();
    }
    expect(
      navigateCommand(
        tab(),
        phone,
        { url: `https://example.com/${"a".repeat(3000)}`, title: "" },
        null,
      ),
    ).toBeNull();
  });
});

describe("navigateCommand ownership", () => {
  const page = { url: "https://example.com/blog", title: "Blog" };

  it("reports only tabs you own, from any of your devices", () => {
    expect(navigateCommand(tab(), desktop, page, null)).not.toBeNull();
    expect(navigateCommand(tab({ owner: agentOwner }), phone, page, null)).toBeNull();
    expect(navigateCommand(tab({ owner: teammateOwner }), phone, page, null)).toBeNull();
    expect(navigateCommand(tab(), null, page, null)).toBeNull();
  });
});

describe("positionCommand", () => {
  const captured = { scrollRatio: 0.5, textFragment: "Getting%20started" };

  it("reports a new position on the record's page", () => {
    expect(positionCommand(tab(), phone, captured, "https://example.com/docs", null)).toEqual({
      _tag: "Position",
      tabId: "tab_a",
      position: captured,
    });
  });

  it("skips a position the record already has", () => {
    expect(
      positionCommand(
        tab({ position: { scrollRatio: 0.505, textFragment: "Getting%20started" } }),
        phone,
        captured,
        "https://example.com/docs",
        null,
      ),
    ).toBeNull();
  });

  it("reports for a page this device just reported, ahead of the record", () => {
    const reported = { url: "https://example.com/blog", title: "Blog" };
    expect(
      positionCommand(tab(), phone, captured, "https://example.com/blog", reported),
    ).not.toBeNull();
  });

  it("skips reporting the top of a page nobody moved", () => {
    expect(
      positionCommand(tab(), phone, { scrollRatio: 0 }, "https://example.com/docs", null),
    ).toBeNull();
  });

  it("never reports a position for a tab you don't own", () => {
    expect(
      positionCommand(
        tab({ owner: agentOwner }),
        phone,
        captured,
        "https://example.com/docs",
        null,
      ),
    ).toBeNull();
  });

  it("skips a page the record doesn't know about", () => {
    expect(positionCommand(tab(), phone, captured, "https://elsewhere.example/", null)).toBeNull();
    expect(positionCommand(tab(), phone, captured, null, null)).toBeNull();
  });
});

describe("positionToRestore", () => {
  const position = { scrollRatio: 0.4, textFragment: "Chapter%202" };

  it("restores where another of your devices left the tab", () => {
    expect(positionToRestore(tab({ position, positionBy: desktop }), phone, null)).toEqual(
      position,
    );
  });

  it("never restores into a tab you don't own", () => {
    expect(
      positionToRestore(tab({ owner: agentOwner, position, positionBy: desktop }), phone, null),
    ).toBeNull();
  });

  it("doesn't restore this device's own position", () => {
    expect(positionToRestore(tab({ position, positionBy: phone }), phone, null)).toBeNull();
  });

  it("restores a playing video's time at the top of the page", () => {
    const video = { scrollRatio: 0, mediaSeconds: 95 };
    expect(positionToRestore(tab({ position: video, positionBy: desktop }), phone, null)).toEqual(
      video,
    );
  });

  it("doesn't restore twice, or a page at its top", () => {
    expect(positionToRestore(tab({ position, positionBy: desktop }), phone, position)).toBeNull();
    expect(
      positionToRestore(tab({ position: { scrollRatio: 0 }, positionBy: desktop }), phone, null),
    ).toBeNull();
    expect(positionToRestore(tab(), phone, null)).toBeNull();
  });
});

describe("urlToFollow", () => {
  const base = {
    tab: tab({ url: "https://example.com/blog" }),
    you: phone,
    previousRecordUrl: "https://example.com/docs",
    reported: [],
    viewUrl: "https://example.com/docs",
  };

  it("follows a navigation from another of your devices", () => {
    expect(urlToFollow(base)).toBe("https://example.com/blog");
  });

  it("doesn't follow its own reports back, even after it moved on", () => {
    const reported = [
      { url: "https://example.com/blog", title: "" },
      { url: "https://example.com/about", title: "" },
    ];
    expect(urlToFollow({ ...base, reported, viewUrl: "https://example.com/about" })).toBeNull();
  });

  it("doesn't reload the page it's already on", () => {
    expect(urlToFollow({ ...base, viewUrl: "https://example.com/blog#:~:text=Hi" })).toBeNull();
  });

  it("leaves a device that navigated locally alone while the record holds still", () => {
    expect(
      urlToFollow({
        ...base,
        previousRecordUrl: "https://example.com/blog",
        viewUrl: "https://example.com/elsewhere",
      }),
    ).toBeNull();
  });

  it("ignores a cleared or non-web address", () => {
    expect(urlToFollow({ ...base, tab: tab({ url: null }) })).toBeNull();
    expect(urlToFollow({ ...base, tab: tab({ url: "javascript:alert(1)" }) })).toBeNull();
  });

  it("never follows a tab someone else owns", () => {
    expect(urlToFollow({ ...base, tab: { ...base.tab, owner: agentOwner } })).toBeNull();
    expect(urlToFollow({ ...base, you: null })).toBeNull();
  });
});

describe("settleReports", () => {
  const report = (url: string, at = 0) => ({ url, title: "", at });

  it("settles a report and everything sent before it once the record reaches it", () => {
    const pending = [
      report("https://a.example/"),
      report("https://b.example/"),
      report("https://c.example/"),
    ];
    expect(settleReports(pending, "https://b.example/", 1).map((r) => r.url)).toEqual([
      "https://c.example/",
    ]);
  });

  it("keeps its reports while someone else's change lands first", () => {
    const pending = [report("https://a.example/")];
    expect(settleReports(pending, "https://elsewhere.example/", 1)).toEqual(pending);
  });

  it("forgets reports that never came back", () => {
    expect(settleReports([report("https://a.example/")], null, 60_000)).toEqual([]);
  });
});

describe("shownBrowsingTab", () => {
  const record: BrowsingRecord = {
    tabs: [tab({ id: "tab_a" }), tab({ id: "tab_b", orderKey: "a2" })],
    activeTabId: "tab_a",
    history: [],
  };

  it("shows the record's active tab", () => {
    expect(shownBrowsingTab(record, null)?.id).toBe("tab_a");
  });

  it("shows this device's pick until the record moves", () => {
    const pending = { tabId: "tab_b", sinceActiveTabId: "tab_a" };
    expect(shownBrowsingTab(record, pending)?.id).toBe("tab_b");
    expect(shownBrowsingTab({ ...record, activeTabId: "tab_b" }, pending)?.id).toBe("tab_b");
  });

  it("follows another member's activation over an older pick", () => {
    const pending = { tabId: "tab_b", sinceActiveTabId: "tab_a" };
    const third = tab({ id: "tab_c", orderKey: "a3" });
    expect(
      shownBrowsingTab({ ...record, tabs: [...record.tabs, third], activeTabId: "tab_c" }, pending)
        ?.id,
    ).toBe("tab_c");
  });

  it("drops a pick for a tab that closed", () => {
    expect(shownBrowsingTab(record, { tabId: "gone", sinceActiveTabId: "tab_a" })?.id).toBe(
      "tab_a",
    );
  });
});

describe("browsingTabEngine", () => {
  it("loads your own tabs here, from whichever of your devices opened them", () => {
    expect(browsingTabEngine(tab(), phone)).toBe("here");
  });

  it("leaves an agent's tabs in its own browser", () => {
    expect(browsingTabEngine(tab({ owner: agentOwner }), phone)).toBe("agent");
  });

  it("leaves another person's tabs in their browser", () => {
    expect(browsingTabEngine(tab({ owner: teammateOwner }), phone)).toBe("person");
  });

  it("loads nothing before it knows who you are", () => {
    expect(browsingTabEngine(tab(), null)).toBe("person");
    expect(browsingTabEngine(tab({ owner: agentOwner }), null)).toBe("agent");
  });
});

describe("browsingTabSubtitle", () => {
  it("names the host of your own tabs", () => {
    expect(browsingTabSubtitle(tab(), phone)).toBe("example.com");
    expect(browsingTabSubtitle(tab({ title: "" }), phone)).toBeUndefined();
    expect(browsingTabSubtitle(tab({ url: null, title: "" }), phone)).toBeUndefined();
  });

  it("marks tabs other people and agents own", () => {
    expect(browsingTabSubtitle(tab({ owner: agentOwner }), phone)).toBe("Agent · example.com");
    expect(browsingTabSubtitle(tab({ owner: agentOwner, url: null, title: "" }), phone)).toBe(
      "Agent",
    );
    expect(browsingTabSubtitle(tab({ owner: teammateOwner }), phone)).toBe(
      "Someone else · example.com",
    );
  });
});

describe("parsePageMessage", () => {
  const message = (fields: Record<string, unknown>) =>
    JSON.stringify({ type: "signalbox-browsing", tabId: "tab_a", ...fields });

  it("reads titles and positions for the shown tab", () => {
    expect(parsePageMessage(message({ kind: "page", title: "Docs" }), "tab_a")).toEqual({
      kind: "page",
      title: "Docs",
    });
    expect(
      parsePageMessage(
        message({ kind: "position", position: JSON.stringify({ scrollRatio: 0.25 }) }),
        "tab_a",
      ),
    ).toEqual({ kind: "position", position: { scrollRatio: 0.25 } });
  });

  it("drops messages for another tab, other senders and bad shapes", () => {
    expect(parsePageMessage(message({ kind: "page", title: "Docs" }), "tab_b")).toBeNull();
    expect(
      parsePageMessage(JSON.stringify({ type: "other", tabId: "tab_a", kind: "page" }), "tab_a"),
    ).toBeNull();
    expect(parsePageMessage(message({ kind: "page", title: 4 }), "tab_a")).toBeNull();
    expect(
      parsePageMessage(
        message({ kind: "position", position: JSON.stringify({ scrollRatio: 7 }) }),
        "tab_a",
      ),
    ).toBeNull();
    expect(parsePageMessage(message({ kind: "navigate", url: "https://x" }), "tab_a")).toBeNull();
    expect(parsePageMessage("not json", "tab_a")).toBeNull();
    expect(parsePageMessage("null", "tab_a")).toBeNull();
    expect(parsePageMessage({ kind: "page" }, "tab_a")).toBeNull();
    expect(parsePageMessage("x".repeat(10_000), "tab_a")).toBeNull();
  });

  it("caps a page's title at the record's limit", () => {
    const parsed = parsePageMessage(message({ kind: "page", title: "t".repeat(900) }), "tab_a");
    expect(parsed?.kind === "page" && parsed.title.length).toBe(512);
  });
});

describe("browsingPageScript", () => {
  it("is self-contained source naming its tab", () => {
    const script = browsingPageScript('tab_"a');
    expect(() => new Function(script)).not.toThrow();
    expect(script).toContain(JSON.stringify('tab_"a'));
  });
});
