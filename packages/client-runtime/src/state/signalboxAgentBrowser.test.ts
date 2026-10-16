import type { AgentBrowserStep, AgentBrowserUpdate } from "@t3tools/contracts/signalboxPreviews";
import { describe, expect, it } from "vite-plus/test";

import {
  isAgentBrowserFreshStart,
  mergeAgentBrowserSteps,
  newAgentBrowserView,
  reduceAgentBrowserUpdate,
  type AgentBrowserView,
} from "./signalboxAgentBrowser.ts";

const snapshot = (at: number) =>
  JSON.stringify([
    { type: 4, data: { href: "https://example.com", width: 1280, height: 720 }, timestamp: at },
    { type: 2, data: { node: { type: 0, childNodes: [], id: 1 } }, timestamp: at },
  ]);
const mutation = (at: number) =>
  JSON.stringify([{ type: 3, data: { source: 0, adds: [] }, timestamp: at }]);

const state = (
  overrides: Partial<Extract<AgentBrowserUpdate, { _tag: "state" }>> = {},
): AgentBrowserUpdate => ({
  _tag: "state",
  viewerId: "viewer-1",
  tabs: [{ tabId: "tab-1", url: "https://example.com", title: "Example", browser: "person" }],
  tabId: "tab-1",
  control: "agent",
  resting: false,
  problem: null,
  notice: null,
  ...overrides,
});

const step = (stepId: string): AgentBrowserStep => ({
  stepId,
  tabId: "tab-1",
  action: "click",
  url: "https://example.com",
  title: "Example",
  startedAt: "2026-10-16T10:00:00.000Z",
  endedAt: "2026-10-16T10:00:01.000Z",
});

const reduce = (updates: ReadonlyArray<AgentBrowserUpdate>, from = newAgentBrowserView()) =>
  updates.reduce<AgentBrowserView>(reduceAgentBrowserUpdate, from);

describe("isAgentBrowserFreshStart", () => {
  it("knows a batch that starts over from a snapshot", () => {
    expect(isAgentBrowserFreshStart(snapshot(1))).toBe(true);
    expect(isAgentBrowserFreshStart(mutation(1))).toBe(false);
    expect(isAgentBrowserFreshStart("[]")).toBe(false);
    expect(isAgentBrowserFreshStart("not json")).toBe(false);
  });

  it("still finds the type when the recorder didn't write it first", () => {
    expect(isAgentBrowserFreshStart('[{"timestamp":1,"data":{},"type":2}]')).toBe(true);
  });
});

describe("reduceAgentBrowserUpdate", () => {
  it("replays a page from its last snapshot and every change since", () => {
    const view = reduce([state(), { _tag: "events", tabId: "tab-1", events: snapshot(1) }]);
    const next = reduce([{ _tag: "events", tabId: "tab-1", events: mutation(2) }], view);
    expect(next.segment?.batches).toEqual([snapshot(1), mutation(2)]);
    expect(next.segment?.id).toBe(view.segment?.id);
  });

  it("appends to one shared array, and an older view still reads only its own batches", () => {
    const view = reduce([state(), { _tag: "events", tabId: "tab-1", events: snapshot(1) }]);
    const next = reduce([{ _tag: "events", tabId: "tab-1", events: mutation(2) }], view);
    expect(next.segment?.batches).toBe(view.segment?.batches);
    expect(view.segment?.count).toBe(1);
    expect(next.segment?.count).toBe(2);
    // Reducing the older view again forks instead of writing into the newer one.
    const fork = reduce([{ _tag: "events", tabId: "tab-1", events: mutation(3) }], view);
    expect(fork.segment?.batches).toEqual([snapshot(1), mutation(3)]);
    expect(next.segment?.batches).toEqual([snapshot(1), mutation(2)]);
  });

  it("starts a new page on a new snapshot, so a reader rebuilds instead of appending", () => {
    const view = reduce([
      state(),
      { _tag: "events", tabId: "tab-1", events: snapshot(1) },
      { _tag: "events", tabId: "tab-1", events: mutation(2) },
    ]);
    const next = reduce([{ _tag: "events", tabId: "tab-2", events: snapshot(3) }], view);
    expect(next.segment).toMatchObject({ tabId: "tab-2", batches: [snapshot(3)] });
    expect(next.segment?.id).not.toBe(view.segment?.id);
  });

  it("drops changes that have no page to apply to", () => {
    const view = reduce([state(), { _tag: "events", tabId: "tab-1", events: mutation(2) }]);
    expect(view.segment).toBeNull();
    const other = reduce([
      state(),
      { _tag: "events", tabId: "tab-1", events: snapshot(1) },
      { _tag: "events", tabId: "tab-2", events: mutation(2) },
    ]);
    expect(other.segment?.batches).toEqual([snapshot(1)]);
  });

  it("gives every subscription its own page ids", () => {
    const first = reduce([state(), { _tag: "events", tabId: "tab-1", events: snapshot(1) }]);
    const second = reduce([state(), { _tag: "events", tabId: "tab-1", events: snapshot(1) }]);
    expect(first.segment?.id).not.toBe(second.segment?.id);
  });

  it("clears the page when the agent has no tab open", () => {
    const view = reduce([
      state(),
      { _tag: "events", tabId: "tab-1", events: snapshot(1) },
      state({ tabId: null, tabs: [] }),
    ]);
    expect(view.segment).toBeNull();
  });

  it("keeps a notice until control changes hands again", () => {
    const handedBack = reduce([
      state({ control: "you" }),
      state({ control: "agent", notice: "Handed back after 2 minutes without input." }),
      state({ control: "agent", resting: true }),
    ]);
    expect(handedBack.notice).toBe("Handed back after 2 minutes without input.");
    expect(reduce([state({ control: "you" })], handedBack).notice).toBeNull();
  });

  it("collects finished steps once each", () => {
    const view = reduce([
      { _tag: "step", step: step("a") },
      { _tag: "step", step: step("b") },
      { _tag: "step", step: step("a") },
    ]);
    expect(view.steps.map((entry) => entry.stepId)).toEqual(["a", "b"]);
  });

  it("forgets the live page and control when the machine goes away, but keeps steps", () => {
    const view = reduce([
      state({ control: "you", problem: "Browser limit reached" }),
      { _tag: "events", tabId: "tab-1", events: snapshot(1) },
      { _tag: "step", step: step("a") },
      { _tag: "offline" },
    ]);
    expect(view).toMatchObject({
      offline: true,
      tabId: null,
      control: "agent",
      problem: null,
      segment: null,
    });
    expect(view.steps).toHaveLength(1);
    expect(reduce([state()], view).offline).toBe(false);
  });
});

describe("mergeAgentBrowserSteps", () => {
  it("appends steps the stored trail doesn't have yet", () => {
    const trail = [step("a"), step("b")];
    expect(mergeAgentBrowserSteps(trail, [step("b"), step("c")]).map((s) => s.stepId)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(mergeAgentBrowserSteps(trail, [step("a")])).toBe(trail);
    expect(mergeAgentBrowserSteps(null, [step("c")]).map((s) => s.stepId)).toEqual(["c"]);
  });
});
