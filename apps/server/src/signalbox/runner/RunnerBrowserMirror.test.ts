// @effect-diagnostics nodeBuiltinImport:off - serves the page a real Chromium opens.
import * as NodeHttp from "node:http";

import type { AgentBrowserStep, AgentBrowserUpdate } from "@t3tools/contracts/signalboxPreviews";
import { type Browser, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { makeRunnerBrowser, type TabSource } from "./RunnerBrowser.ts";
import { AGENT_WAIT_MS, PERSON_DRIVING, type Timer } from "./RunnerBrowserControl.ts";

/**
 * The agent's browser as a person watches it (#587), on a real Chromium: the
 * recorder's snapshot and mutations reach a viewer, finished actions become
 * trail steps, and a viewer who takes over types into the page while the
 * agent's actions wait.
 */

const PAGE = `<title>Form</title>
<label>Name <input id="name"></label>
<button onclick="document.body.append(Object.assign(document.createElement('p'), { textContent: 'clicked' }))">Add</button>`;
const CANVAS_PAGE = `<title>Canvas</title>
<canvas id="art" width="40" height="40"></canvas>
<button>Go</button>
<script>const c = document.getElementById("art").getContext("2d"); c.fillStyle = "red"; c.fillRect(0, 0, 40, 40);</script>`;

let server: NodeHttp.Server;
let origin = "";
let chrome: Browser;

beforeAll(async () => {
  server = NodeHttp.createServer((request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(request.url === "/canvas" ? CANVAS_PAGE : PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  chrome = await chromium.launch({ headless: true });
}, 60_000);

afterAll(async () => {
  await chrome?.close();
  server?.close();
});

const machineTabs = async (): Promise<TabSource> => {
  const context = await chrome.newContext();
  return { newPage: () => context.newPage(), close: () => context.close() };
};

/** Timers the test fires by hand; `armed` resolves once one for `ms` is set. */
const manualTimers = () => {
  const set = new Set<{ readonly run: () => void; readonly ms: number }>();
  const waiting = new Set<{ readonly ms: number; readonly resolve: () => void }>();
  const timer: Timer = (run, ms) => {
    const entry = { run, ms };
    set.add(entry);
    for (const wait of waiting)
      if (wait.ms === ms) {
        waiting.delete(wait);
        wait.resolve();
      }
    return () => void set.delete(entry);
  };
  return {
    timer,
    armed: (ms: number) =>
      [...set].some((entry) => entry.ms === ms)
        ? Promise.resolve()
        : new Promise<void>((resolve) => waiting.add({ ms, resolve })),
    fire: (ms: number) => {
      for (const entry of set)
        if (entry.ms === ms) {
          set.delete(entry);
          entry.run();
        }
    },
  };
};

/** Everything a stream carries, and a way to wait for the update the test needs next. */
const collect = <A>() => {
  const seen: Array<A> = [];
  const waiting = new Set<{
    readonly test: (item: A) => boolean;
    readonly resolve: (item: A) => void;
  }>();
  return {
    seen,
    push: (item: A) => {
      seen.push(item);
      for (const wait of waiting)
        if (wait.test(item)) {
          waiting.delete(wait);
          wait.resolve(item);
        }
    },
    /** The first item from `from` on that passes `test`. */
    next: (test: (item: A) => boolean, from = 0) => {
      const found = seen.slice(from).find(test);
      return found !== undefined
        ? Promise.resolve(found)
        : new Promise<A>((resolve) => waiting.add({ test, resolve }));
    },
  };
};

interface RrwebEvent {
  readonly type: number;
  readonly data?: { readonly source?: number; readonly text?: string };
}
const eventsOf = (update: AgentBrowserUpdate): ReadonlyArray<RrwebEvent> =>
  update._tag === "events" ? (JSON.parse(update.events) as ReadonlyArray<RrwebEvent>) : [];
const decoder = new TextDecoder();
const FULL_SNAPSHOT = 2;
const INCREMENTAL = 3;
const META = 4;

describe("the agent's browser, mirrored", () => {
  it("shows a viewer the page and its changes, and lets them type into it", async () => {
    const timers = manualTimers();
    const browser = makeRunnerBrowser(
      { machine: await machineTabs(), person: null },
      { timer: timers.timer },
    );
    const steps = collect<{ readonly step: AgentBrowserStep; readonly events: string }>();
    browser.mirror!.onStep((step, events) => steps.push({ step, events }));
    const updates = collect<AgentBrowserUpdate>();
    try {
      const opened = await browser.navigate({ url: `${origin}/` });
      const viewer = browser.mirror!.watch({
        viewerId: "viewer-1",
        tabId: null,
        send: (line) => updates.push(JSON.parse(decoder.decode(line)) as AgentBrowserUpdate),
        end: () => {},
      });
      expect(updates.seen[0]).toMatchObject({
        _tag: "state",
        viewerId: "viewer-1",
        tabId: opened.tabId,
        tabs: [{ tabId: opened.tabId, url: `${origin}/`, browser: "machine" }],
        control: "agent",
        resting: false,
        problem: null,
      });

      // The page as it is: a full snapshot with the form in it.
      const snapshot = await updates.next(
        (update) =>
          update._tag === "events" &&
          eventsOf(update).some((event) => event.type === FULL_SNAPSHOT) &&
          update.events.includes("Add"),
      );
      expect(snapshot).toMatchObject({ tabId: opened.tabId });

      // The navigation is a step of the trail, replayable on its own.
      const navigated = await steps.next((each) => each.step.action === "navigate");
      expect(navigated.step).toMatchObject({ tabId: opened.tabId, url: `${origin}/` });
      expect((JSON.parse(navigated.events) as Array<RrwebEvent>)[0]!.type).toBe(META);

      // A change to the page reaches the viewer as a mutation, not a new snapshot.
      const before = updates.seen.length;
      await browser.evaluate({
        expression:
          "document.body.append(Object.assign(document.createElement('p'), { textContent: 'by script' }))",
      });
      // (Watching restarts the recording with canvases, so a full snapshot may land beside it.)
      await updates.next(
        (update) =>
          eventsOf(update).some(
            (event) => event.type === INCREMENTAL && JSON.stringify(event).includes("by script"),
          ),
        before,
      );

      const box = (await browser.evaluate({
        expression:
          "(() => { const r = document.querySelector('#name').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()",
      })) as { readonly x: number; readonly y: number };

      viewer.input({ _tag: "take" });
      await updates.next((update) => update._tag === "state" && update.control === "you");
      expect((await browser.status({})).control).toMatchObject({
        owner: "human",
        ownedByCaller: false,
      });

      // The agent's next action waits for the person.
      const agentClick = browser.click({ locator: "role=button[name='Add']" });
      await timers.armed(AGENT_WAIT_MS);

      const typed = updates.seen.length;
      const mouse = { x: box.x, y: box.y, clickCount: 1, modifiers: 0 } as const;
      viewer.input({ _tag: "mouse", action: "down", button: "left", buttons: 1, ...mouse });
      viewer.input({ _tag: "mouse", action: "up", button: "left", buttons: 0, ...mouse });
      viewer.input({ _tag: "text", text: "Ada" });
      const input = await updates.next(
        (update) =>
          update._tag === "events" &&
          eventsOf(update).some(
            (event) => event.type === INCREMENTAL && event.data?.text === "Ada",
          ),
        typed,
      );
      expect(input).toMatchObject({ tabId: opened.tabId });
      // Reads don't wait for the person.
      expect((await browser.snapshot({})).visibleText).toContain("by script");

      viewer.input({ _tag: "release" });
      await agentClick;
      const person = await steps.next((each) => each.step.action === "person");
      expect(person.events).toContain("Ada");
      expect(await browser.evaluate({ expression: "document.querySelector('#name').value" })).toBe(
        "Ada",
      );
      expect((await browser.status({})).control).toMatchObject({ owner: "agent" });
      await steps.next((each) => each.step.action === "click");
    } finally {
      await browser.close();
    }
  }, 60_000);

  it("tells the agent the person is driving once it waited long enough", async () => {
    const timers = manualTimers();
    const browser = makeRunnerBrowser(
      { machine: await machineTabs(), person: null },
      { timer: timers.timer },
    );
    const updates = collect<AgentBrowserUpdate>();
    try {
      await browser.navigate({ url: `${origin}/` });
      const viewer = browser.mirror!.watch({
        viewerId: "viewer-1",
        tabId: null,
        send: (line) => updates.push(JSON.parse(decoder.decode(line)) as AgentBrowserUpdate),
        end: () => {},
      });
      viewer.input({ _tag: "take" });
      await updates.next((update) => update._tag === "state" && update.control === "you");

      const waiting = browser.press({ key: "Enter" });
      await timers.armed(AGENT_WAIT_MS);
      timers.fire(AGENT_WAIT_MS);
      await expect(waiting).rejects.toThrow(PERSON_DRIVING);

      // Leaving hands the tab back.
      viewer.close();
      await browser.press({ key: "Enter" });
    } finally {
      await browser.close();
    }
  }, 60_000);

  it("ends steps on actions that change the page; hovers ride with the next one", async () => {
    const browser = makeRunnerBrowser({ machine: await machineTabs(), person: null });
    const steps = collect<AgentBrowserStep>();
    browser.mirror!.onStep((step) => steps.push(step));
    try {
      await browser.navigate({ url: `${origin}/` });
      await browser.hover({ locator: "role=button[name='Add']" });
      await browser.click({ locator: "role=button[name='Add']" });
      await steps.next((step) => step.action === "click");
      expect(steps.seen.map((step) => step.action)).toEqual(["navigate", "click"]);
    } finally {
      await browser.close();
    }
  }, 60_000);

  it("records canvases only while someone watches the tab", async () => {
    const browser = makeRunnerBrowser({ machine: await machineTabs(), person: null });
    const steps = collect<{ readonly step: AgentBrowserStep; readonly events: string }>();
    browser.mirror!.onStep((step, events) => steps.push({ step, events }));
    const updates = collect<AgentBrowserUpdate>();
    try {
      await browser.navigate({ url: `${origin}/canvas` });
      const navigated = await steps.next((each) => each.step.action === "navigate");
      expect(navigated.events).not.toContain("rr_dataURL");

      const viewer = browser.mirror!.watch({
        viewerId: "viewer-1",
        tabId: null,
        send: (line) => updates.push(JSON.parse(decoder.decode(line)) as AgentBrowserUpdate),
        end: () => {},
      });
      await updates.next(
        (update) =>
          update._tag === "events" &&
          eventsOf(update).some((event) => event.type === FULL_SNAPSHOT) &&
          update.events.includes("rr_dataURL"),
      );

      viewer.close();
      await browser.click({ locator: "role=button[name='Go']" });
      await browser.click({ locator: "role=button[name='Go']" });
      const clicks = await steps.next(
        (each) => each.step.action === "click" && steps.seen.indexOf(each) === 2,
      );
      // The step after the viewer left starts from a snapshot without the canvas's pixels.
      expect(clicks.events).toContain("Go");
      expect(clicks.events).not.toContain("rr_dataURL");
    } finally {
      await browser.close();
    }
  }, 60_000);
});
