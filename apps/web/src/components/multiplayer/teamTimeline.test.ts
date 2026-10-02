import { describe, expect, it } from "vite-plus/test";

import { settleTurn } from "./localMessages";
import type { TeamMessage } from "./multiplayerModel";
import { waitingForReplies } from "./replyMode";
import { TEAM_MESSAGES } from "./teamMessageFixtures";
import { buildTeamTimeline, encodeMentions } from "./teamTimeline";

const say = (id: string, personId: string): TeamMessage => ({
  id,
  author: { kind: "person", personId },
  body: "hi",
  at: "09:00",
});
const answer = (id: string, personId: string): TeamMessage => ({
  id,
  author: { kind: "agent", name: "Codex", startedById: personId },
  body: "done",
  at: "09:01",
});

describe("buildTeamTimeline", () => {
  it("renders each agent turn as its work, then the answer, in order", () => {
    const timeline = buildTeamTimeline({
      threadId: "t",
      messages: TEAM_MESSAGES["mp-refund-webhooks"] ?? [],
      endsAt: "2026-09-30T10:00:00.000Z",
    });
    const kinds = timeline.entries.slice(0, 5).map((entry) => entry.kind);
    expect(kinds).toEqual(["message", "work", "work", "message", "proposed-plan"]);
    expect(timeline.authors.get("t:m1")).toBe("yannic");
    expect(timeline.harnesses.get("t:m4")?.harness.model).toBe("Claude Sonnet 4.5");
    expect(timeline.events.get("t:e1")).toBe("model");
  });

  it("adds the hold as a separator when waiting", () => {
    const timeline = buildTeamTimeline({
      threadId: "t",
      messages: [say("m1", "sam")],
      endsAt: "2026-09-30T10:00:00.000Z",
      waitingLabel: "Waiting for Samir before replying",
    });
    expect(timeline.events.get("t:waiting")).toBe("waiting");
  });

  it("encodes people mentions as timeline references", () => {
    expect(encodeMentions("@Flynn ok")).toBe("[@Flynn Moretti](t3-context://v1/person/flo) ok");
  });
});

describe("live turns", () => {
  it("drives the running turn and holds the answer while thinking", () => {
    const timeline = buildTeamTimeline({
      threadId: "t",
      messages: TEAM_MESSAGES["mp-settlement-pagination"] ?? [],
      endsAt: "2026-09-30T10:00:00.000Z",
    });
    expect(timeline.activeTurn?.turnId).toBe("t:m4:turn");
    const last = timeline.entries.at(-1);
    expect(last?.kind === "message" ? last.message.role : null).toBe("reasoning");
  });

  it("surfaces the approval a working turn waits on", () => {
    const timeline = buildTeamTimeline({
      threadId: "t",
      messages: TEAM_MESSAGES["mp-refund-webhooks"] ?? [],
      endsAt: "2026-09-30T10:00:00.000Z",
    });
    expect(timeline.activeTurn?.approval?.detail).toContain("git push");
    expect(timeline.activeTurn?.forPersonId).toBe("yannic");
  });
});

describe("local sends", () => {
  const sentAt = Date.parse("2026-09-30T10:00:00.000Z");
  const prompt: TeamMessage = {
    ...say("p", "yannic"),
    createdAt: new Date(sentAt).toISOString(),
  };
  const liveTurn: TeamMessage = {
    ...answer("a", "yannic"),
    createdAt: new Date(sentAt + 1_000).toISOString(),
    live: "working",
    reasoning: "Finding the call sites first.",
    work: [{ label: "Search", command: 'rg -n "refund" src', running: true }],
  };

  it("keeps a turn's reasoning and work after the message it answers", () => {
    const timeline = buildTeamTimeline({
      threadId: "t",
      messages: [prompt, liveTurn],
      endsAt: "2026-09-30T10:00:01.000Z",
    });
    expect(timeline.entries.map((entry) => entry.id)).toEqual([
      "t:p",
      "t:a:reasoning",
      "t:a:work-0",
    ]);
    expect(Date.parse(timeline.activeTurn?.startedAt ?? "")).toBeGreaterThan(sentAt);
  });

  it("settles a live turn into its finished answer", () => {
    const settled = settleTurn(liveTurn);
    expect(settled.live).toBeUndefined();
    expect(settled.work?.[0]?.running).toBeUndefined();
    const timeline = buildTeamTimeline({
      threadId: "t",
      messages: [prompt, settled],
      endsAt: "2026-09-30T10:00:01.000Z",
    });
    expect(timeline.activeTurn).toBeNull();
    expect(timeline.entries.at(-1)?.id).toBe("t:a");
  });
});

describe("waitingForReplies", () => {
  it("waits for participants who haven't posted since the last answer", () => {
    const messages = [say("1", "sam"), answer("2", "sam"), say("3", "yannic")];
    expect(waitingForReplies(messages).map((person) => person.id)).toEqual(["sam"]);
    expect(waitingForReplies([...messages, say("4", "sam")])).toEqual([]);
    expect(waitingForReplies(messages.slice(0, 2))).toEqual([]);
  });
});
