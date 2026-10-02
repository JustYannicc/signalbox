import { describe, expect, it } from "vite-plus/test";

import { scopeDeviation } from "./containerScope";
import { mentionedPeople, segmentMentions, unansweredMentions } from "./mentions";
import type { TeamMessage } from "./multiplayerModel";

const say = (id: string, personId: string, body: string): TeamMessage => ({
  id,
  author: { kind: "person", personId },
  body,
  at: "09:00",
});

describe("mentions", () => {
  it("resolves teammates, your assistant and your agents, but not teammates' assistants", () => {
    const text = '@Flynn ask @Appa or @"Northwind team agent" but not @Pip';
    const kinds = segmentMentions(text)
      .filter((segment) => segment.mention)
      .map((segment) => segment.mention?.kind);
    expect(kinds).toEqual(["person", "assistant", "agent"]);
    expect(
      segmentMentions(text)
        .map((segment) => segment.text)
        .join(""),
    ).toBe(text);
  });

  it("keeps trailing punctuation out of the mention and counts one that ends the message", () => {
    expect(mentionedPeople("thoughts, @Samir.").map((person) => person.id)).toEqual(["sam"]);
  });

  it("tracks waits you're part of until that person posts", () => {
    const asked = [say("1", "yannic", "@Flynn is 409 delivered?")];
    expect(unansweredMentions(asked).map((pending) => pending.person.id)).toEqual(["flo"]);
    expect(unansweredMentions([...asked, say("2", "flo", "Yes.")])).toEqual([]);
    expect(unansweredMentions([say("1", "sam", "@Flynn can we?")])).toEqual([]);
  });
});

describe("scopeDeviation", () => {
  it("flags only departures from the container default", () => {
    expect(scopeDeviation({ containerId: "work-northwind", visibility: "shared" })).toBeNull();
    expect(scopeDeviation({ containerId: "merchant-portal", visibility: "private" })).toBe(
      "private-in-shared",
    );
    expect(
      scopeDeviation({
        containerId: "section:personal",
        visibility: "private",
        grantedIds: ["flo"],
      }),
    ).toBe("shared-in-private");
  });

  it("treats rooms as private by default in any container", () => {
    expect(
      scopeDeviation({ containerId: "work-northwind", visibility: "private", kind: "room" }),
    ).toBeNull();
    expect(
      scopeDeviation({ containerId: "work-northwind", visibility: "shared", kind: "room" }),
    ).toBe("shared-in-private");
  });
});
