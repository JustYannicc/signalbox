import type { BrowsingTab } from "@t3tools/contracts/signalboxBrowsing";
import { describe, expect, it } from "@effect/vitest";

import {
  capturePagePositionScript,
  parseCapturedPosition,
  positionMoved,
  restorablePosition,
  restorePagePositionScript,
  samePagePosition,
  textFragmentFor,
  textFromFragment,
} from "./pagePosition.ts";

describe("text fragments", () => {
  it("keeps the first words of a passage, encoded like Chrome's text directive", () => {
    const fragment = textFragmentFor(
      "  Getting started,   with the CLI - a long walkthrough of every step ",
    );
    expect(fragment).toBe("Getting%20started%2C%20with%20the%20CLI%20%2D%20a%20long");
    expect(textFromFragment(fragment ?? "")).toBe("Getting started, with the CLI - a long");
  });

  it("reads only the start of a ranged directive", () => {
    expect(textFromFragment("Getting%20started,the%20end")).toBe("Getting started");
    expect(textFromFragment("prefix-,Getting%20started")).toBe("Getting started");
  });

  it("has nothing to anchor on in too little text", () => {
    expect(textFragmentFor("Menu")).toBeUndefined();
  });
});

describe("parseCapturedPosition", () => {
  it("accepts what the page reports", () => {
    expect(
      parseCapturedPosition(
        JSON.stringify({
          scrollRatio: 0.4321,
          textFragment: "Getting%20started",
          mediaSeconds: 61,
        }),
      ),
    ).toEqual({ scrollRatio: 0.432, textFragment: "Getting%20started", mediaSeconds: 61 });
    expect(parseCapturedPosition(JSON.stringify({ scrollRatio: 0 }))).toEqual({ scrollRatio: 0 });
  });

  it("rejects anything else a page might send", () => {
    expect(parseCapturedPosition("not json")).toBeNull();
    expect(parseCapturedPosition(JSON.stringify({ scrollRatio: 3 }))).toBeNull();
    expect(parseCapturedPosition(JSON.stringify({ scrollRatio: 0.5, textFragment: 7 }))).toEqual({
      scrollRatio: 0.5,
    });
  });
});

describe("samePagePosition", () => {
  it("treats a playing video's next few seconds as the same place", () => {
    const watching = { scrollRatio: 0.2, mediaSeconds: 60 };
    expect(samePagePosition(watching, { scrollRatio: 0.2, mediaSeconds: 63 })).toBe(true);
    expect(samePagePosition(watching, { scrollRatio: 0.2, mediaSeconds: 95 })).toBe(false);
    expect(samePagePosition(watching, { scrollRatio: 0.2 })).toBe(false);
    expect(samePagePosition(undefined, { scrollRatio: 0 })).toBe(false);
  });
});

describe("page scripts", () => {
  it("are self-contained expressions an engine can evaluate", () => {
    // Parses as an expression without running it: no imports, no outer references.
    expect(() => new Function(`return (${capturePagePositionScript});`)).not.toThrow();
    const restore = restorePagePositionScript({ scrollRatio: 0.5, textFragment: "a%20b" });
    expect(() => new Function(`return (${restore});`)).not.toThrow();
    expect(restore).toContain('const passage = "a b";');
  });
});

describe("what to sync", () => {
  const phone = { _tag: "Device", userId: "u", deviceId: "phone" } as const;
  const desktop = { _tag: "Device", userId: "u", deviceId: "desktop" } as const;
  const tab: BrowsingTab = {
    id: "a",
    url: "https://example.com/",
    title: "",
    orderKey: "a0",
    owner: { _tag: "Person", userId: "u" },
    updatedAt: "",
  };

  it("restores only someone else's position below the top", () => {
    const read = { ...tab, position: { scrollRatio: 0.5 }, positionBy: desktop };
    expect(restorablePosition(read, phone)).toEqual({ scrollRatio: 0.5 });
    expect(restorablePosition(read, desktop)).toBeNull();
    expect(restorablePosition({ ...read, position: { scrollRatio: 0 } }, phone)).toBeNull();
    expect(
      restorablePosition({ ...read, position: { scrollRatio: 0, mediaSeconds: 90 } }, phone),
    ).toEqual({ scrollRatio: 0, mediaSeconds: 90 });
    expect(restorablePosition(tab, phone)).toBeNull();
  });

  it("reports a position only when it moved", () => {
    expect(positionMoved(tab, { scrollRatio: 0 })).toBe(false);
    expect(positionMoved(tab, { scrollRatio: 0.3 })).toBe(true);
    const read = { ...tab, position: { scrollRatio: 0.3 } };
    expect(positionMoved(read, { scrollRatio: 0.302 })).toBe(false);
    expect(positionMoved(read, { scrollRatio: 0.6 })).toBe(true);
  });
});
