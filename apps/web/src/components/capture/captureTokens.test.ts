import { describe, expect, it } from "vite-plus/test";

import { captureDraftHasContent } from "./captureDraftStore";
import {
  assistantToken,
  findActiveTrigger,
  parsePastedUrl,
  routingHint,
  withToken,
  type CaptureToken,
} from "./captureTokens";
import { captureVisibility, visibilityLabel } from "./captureVisibility";

const flynn: CaptureToken = { id: "share:flo", kind: "share", label: "Flynn" };
const privateToken: CaptureToken = { id: "private", kind: "private", label: "Private" };
const merchantPortal: CaptureToken = {
  id: "team-project:merchant-portal",
  kind: "project",
  label: "merchant-portal",
  containerKey: "team-project:merchant-portal",
};
const personal: CaptureToken = {
  id: "section:personal",
  kind: "section",
  label: "Personal",
  containerKey: "section:personal",
};

describe("findActiveTrigger", () => {
  it("finds #, @ and + tokens at the caret", () => {
    expect(findActiveTrigger("call #merch", 11)).toMatchObject({ trigger: "#", query: "merch" });
    expect(findActiveTrigger("ask @flo", 8)).toMatchObject({ trigger: "@", query: "flo" });
    expect(findActiveTrigger("notes +Wal", 10)).toMatchObject({
      trigger: "+",
      query: "Wal",
      start: 6,
    });
  });

  it("ignores symbols inside words", () => {
    expect(findActiveTrigger("a+b", 3)).toBeNull();
    expect(findActiveTrigger("mail@example", 12)).toBeNull();
  });
});

describe("withToken", () => {
  it("makes +private and +someone exclude each other", () => {
    expect(withToken([flynn], privateToken)).toEqual([privateToken]);
    expect(withToken([privateToken, merchantPortal], flynn)).toEqual([merchantPortal, flynn]);
  });

  it("does not add a token twice", () => {
    const tokens = [flynn];
    expect(withToken(tokens, flynn)).toBe(tokens);
  });
});

describe("captureVisibility", () => {
  it("is private by default, even in a private folder", () => {
    expect(captureVisibility([])).toEqual({ scope: "private" });
    expect(captureVisibility([personal])).toEqual({ scope: "private" });
  });

  it("follows a shared container's team unless +private or +someone says otherwise", () => {
    const fromContainer = captureVisibility([merchantPortal]);
    expect(visibilityLabel(fromContainer)).toBe(
      "shared with Northwind team (from merchant-portal)",
    );
    expect(captureVisibility([merchantPortal, privateToken])).toEqual({ scope: "private" });
    expect(visibilityLabel(captureVisibility([merchantPortal, flynn]))).toBe("shared with Flynn");
  });
});

describe("parsePastedUrl", () => {
  it("accepts exactly one URL", () => {
    expect(parsePastedUrl(" https://youtu.be/abc ")).toBe("https://youtu.be/abc");
    expect(parsePastedUrl("www.example.com/x")).toBe("https://www.example.com/x");
    expect(parsePastedUrl("see https://example.com")).toBeNull();
  });
});

describe("assistant chip", () => {
  it("routes to the assistant with the chip and to a new chat without it", () => {
    expect(routingHint([assistantToken("Appa"), merchantPortal, flynn], "Appa")).toBe(
      "→ Appa · merchant-portal",
    );
    expect(routingHint([merchantPortal], "Appa")).toBe("→ new chat · merchant-portal");
    expect(routingHint([], "Appa")).toBe("→ new chat");
  });

  it("is not a draft on its own", () => {
    const draft = { text: "", tokens: [assistantToken("Appa")], links: [], updatedAt: null };
    expect(captureDraftHasContent(draft)).toBe(false);
    expect(captureDraftHasContent({ ...draft, tokens: [...draft.tokens, merchantPortal] })).toBe(
      true,
    );
  });
});
