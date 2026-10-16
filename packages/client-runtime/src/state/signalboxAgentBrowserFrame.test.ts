import { newAgentBrowserView, type AgentBrowserView } from "./signalboxAgentBrowser.ts";
import { describe, expect, it } from "vite-plus/test";

import {
  AGENT_BROWSER_MIRROR_NOTHING_DELIVERED as NOTHING,
  agentBrowserFrame,
  agentBrowserMirrorContent,
  agentBrowserPlaceLabel,
  agentBrowserStatus,
  agentBrowserStepLabel,
  planAgentBrowserMirrorDelivery,
  type AgentBrowserMirrorContent,
} from "./signalboxAgentBrowserFrame.ts";

const segment = { id: "1:1", tabId: "tab-1", batches: ["[]"], count: 1 };
const view = (overrides: Partial<AgentBrowserView> = {}): AgentBrowserView => ({
  ...newAgentBrowserView(),
  viewerId: "viewer-1",
  tabId: "tab-1",
  segment,
  ...overrides,
});

describe("agentBrowserFrame", () => {
  it("keeps the last frame while paused or while the page is on its way", () => {
    expect(agentBrowserFrame({ view: null, selectedStepId: null, lastStepId: "a" })).toEqual({
      kind: "hold",
    });
    expect(
      agentBrowserFrame({ view: view({ segment: null }), selectedStepId: null, lastStepId: null }),
    ).toEqual({ kind: "hold" });
  });

  it("shows a picked step over everything else", () => {
    expect(agentBrowserFrame({ view: view(), selectedStepId: "b", lastStepId: "c" })).toEqual({
      kind: "step",
      stepId: "b",
    });
  });

  it("falls back to the last step once the machine is off", () => {
    const offline = view({ offline: true, tabId: null, segment: null });
    expect(agentBrowserFrame({ view: offline, selectedStepId: null, lastStepId: "c" })).toEqual({
      kind: "step",
      stepId: "c",
    });
    expect(agentBrowserFrame({ view: offline, selectedStepId: null, lastStepId: null }).kind).toBe(
      "blank",
    );
  });

  it("goes blank when the agent closed its last tab", () => {
    expect(
      agentBrowserFrame({ view: view({ tabId: null }), selectedStepId: null, lastStepId: "c" })
        .kind,
    ).toBe("blank");
    expect(agentBrowserFrame({ view: view(), selectedStepId: null, lastStepId: null })).toEqual({
      kind: "live",
      segment,
    });
  });
});

describe("agentBrowserStatus", () => {
  it("always says who drives a live tab", () => {
    expect(
      agentBrowserStatus({
        view: view({ control: "you" }),
        watching: true,
        error: null,
        hasSteps: true,
      }),
    ).toEqual({ control: "You're driving · the agent waits", detail: null });
    expect(
      agentBrowserStatus({
        view: view({ resting: true }),
        watching: true,
        error: null,
        hasSteps: true,
      }),
    ).toEqual({ control: "The agent is driving", detail: "Resting · showing the last state" });
  });

  it("puts a notice ahead of resting", () => {
    expect(
      agentBrowserStatus({
        view: view({ resting: true, notice: "Handed back after 2 minutes without input." }),
        watching: true,
        error: null,
        hasSteps: false,
      }).detail,
    ).toBe("Handed back after 2 minutes without input.");
  });

  it("says when it stopped watching", () => {
    expect(
      agentBrowserStatus({ view: null, watching: false, error: null, hasSteps: true }),
    ).toEqual({
      control: null,
      detail: "Paused while you're away",
    });
  });
});

const live = (id: string, batches: ReadonlyArray<string>): AgentBrowserMirrorContent => ({
  kind: "live",
  segment: { id, tabId: "tab-1", batches: [...batches], count: batches.length },
});

describe("planAgentBrowserMirrorDelivery", () => {
  it("sends each live batch once, then only the new ones", () => {
    const first = planAgentBrowserMirrorDelivery(live("1:1", ["[1]", "[2]"]), NOTHING);
    expect(first.messages).toEqual([
      { type: "events", events: "[1]" },
      { type: "events", events: "[2]" },
    ]);
    const next = planAgentBrowserMirrorDelivery(
      live("1:1", ["[1]", "[2]", "[3]"]),
      first.delivered,
    );
    expect(next.messages).toEqual([{ type: "events", events: "[3]" }]);
    expect(
      planAgentBrowserMirrorDelivery(live("1:1", ["[1]", "[2]", "[3]"]), next.delivered).messages,
    ).toEqual([]);
  });

  it("sends only the batches this view has, though the shared array may hold more", () => {
    const shared = ["[1]", "[2]", "[3]"];
    const plan = planAgentBrowserMirrorDelivery(
      { kind: "live", segment: { id: "1:1", tabId: "tab-1", batches: shared, count: 2 } },
      NOTHING,
    );
    expect(plan.messages).toEqual([
      { type: "events", events: "[1]" },
      { type: "events", events: "[2]" },
    ]);
    expect(plan.delivered.count).toBe(2);
  });

  it("starts a new segment from its first batch", () => {
    const old = planAgentBrowserMirrorDelivery(live("1:1", ["[1]", "[2]"]), NOTHING).delivered;
    expect(planAgentBrowserMirrorDelivery(live("1:2", ["[9]"]), old).messages).toEqual([
      { type: "events", events: "[9]" },
    ]);
  });

  it("replaces the page with a recording once, and holds without sending", () => {
    const recording = { kind: "recording", id: "step-1", events: "[5]" } as const;
    const shown = planAgentBrowserMirrorDelivery(recording, NOTHING);
    expect(shown.messages).toEqual([{ type: "reset" }, { type: "events", events: "[5]" }]);
    expect(planAgentBrowserMirrorDelivery(recording, shown.delivered).messages).toEqual([]);
    const held = planAgentBrowserMirrorDelivery({ kind: "hold" }, shown.delivered);
    expect(held).toEqual({ messages: [], delivered: shown.delivered });
  });

  it("resets for blank once", () => {
    const blank = planAgentBrowserMirrorDelivery({ kind: "blank" }, NOTHING);
    expect(blank.messages).toEqual([{ type: "reset" }]);
    expect(planAgentBrowserMirrorDelivery({ kind: "blank" }, blank.delivered).messages).toEqual([]);
  });
});

describe("agentBrowserMirrorContent", () => {
  it("holds a step until its recording loads, then shows it", () => {
    const frame = { kind: "step", stepId: "a" } as const;
    expect(agentBrowserMirrorContent(frame, null)).toEqual({ kind: "hold" });
    expect(agentBrowserMirrorContent(frame, { events: "[5]" })).toEqual({
      kind: "recording",
      id: "a",
      events: "[5]",
    });
    expect(agentBrowserMirrorContent({ kind: "live", segment }, null)).toEqual({
      kind: "live",
      segment,
    });
    expect(agentBrowserMirrorContent({ kind: "blank", reason: "x" }, null)).toEqual({
      kind: "blank",
    });
  });
});

describe("labels", () => {
  it("names known steps, and a newer machine's action as itself", () => {
    expect(agentBrowserStepLabel("click")).toBe("Clicked");
    expect(agentBrowserStepLabel("hover")).toBe("Hover");
    expect(agentBrowserStepLabel("toString")).toBe("ToString");
    expect(agentBrowserStepLabel("")).toBe("Step");
  });

  it("names a place by its title, then its host, then the fallback", () => {
    expect(agentBrowserPlaceLabel("Docs", "https://example.com/a", "New tab")).toBe("Docs");
    expect(agentBrowserPlaceLabel(" ", "https://example.com/a", "New tab")).toBe("example.com");
    expect(agentBrowserPlaceLabel("", "about:blank", "New tab")).toBe("New tab");
    expect(agentBrowserPlaceLabel("", "not a url", "not a url")).toBe("not a url");
  });
});
