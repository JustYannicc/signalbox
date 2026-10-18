// @effect-diagnostics nodeBuiltinImport:off - serves the page a real Chromium opens.
import * as NodeHttp from "node:http";
import * as NodeURL from "node:url";

import type { AgentBrowserStep, AgentBrowserUpdate } from "@t3tools/contracts/signalboxPreviews";
import { type Browser, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { makeRunnerBrowser, type TabSource } from "./RunnerBrowser.ts";
import { AGENT_WAIT_MS, PERSON_DRIVING } from "./RunnerBrowserControl.ts";
import { manualTimers } from "./runnerBrowserTesting.ts";

/**
 * The agent's browser as a person watches it (#587), on a real Chromium: the
 * recorder's snapshot and mutations reach a viewer, finished actions become
 * trail steps, and a viewer who takes over types into the page while the
 * agent's actions wait.
 */

const PAGE = `<title>Form</title>
<label>Name <input id="name" oninput="console.log('typed ' + this.value)"></label>
<button onclick="document.body.append(Object.assign(document.createElement('p'), { textContent: 'clicked' }))">Add</button>`;
const CANVAS_PAGE = `<title>Canvas</title>
<canvas id="art" width="40" height="40"></canvas>
<button>Go</button>
<script>const c = document.getElementById("art").getContext("2d"); c.fillStyle = "red"; c.fillRect(0, 0, 40, 40);</script>`;

// Two buttons side by side; the test swaps them after the mirror recorded them.
const TARGETS_PAGE = `<title>Targets</title>
<style>body { margin: 0 } button { position: absolute; top: 20px; width: 100px; height: 40px; border: 0 }</style>
<button id="target" style="left: 20px" onclick="hits.push('target')">Target</button>
<button id="decoy" style="left: 140px" onclick="hits.push('decoy')">Decoy</button>
<script>window.hits = [];</script>`;

let server: NodeHttp.Server;
let origin = "";
let chrome: Browser;

beforeAll(async () => {
  server = NodeHttp.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/__signalbox/preview") {
      response.writeHead(302, { location: url.searchParams.get("path") ?? "/" });
      response.end();
      return;
    }
    response.setHeader("content-type", "text/html");
    response.end(
      url.pathname === "/canvas" ? CANVAS_PAGE : url.pathname === "/targets" ? TARGETS_PAGE : PAGE,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  chrome = await chromium.launch({
    headless: true,
    args: ["--host-resolver-rules=MAP preview.example.test 127.0.0.1"],
  });
}, 60_000);

afterAll(async () => {
  await chrome?.close();
  server?.close();
});

const machineTabs = async (): Promise<TabSource> => {
  const context = await chrome.newContext();
  return { newPage: () => context.newPage(), close: () => context.close() };
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

interface RrwebNode {
  readonly id: number;
  readonly attributes?: Record<string, unknown>;
  readonly childNodes?: ReadonlyArray<RrwebNode>;
}
interface RrwebEvent {
  readonly type: number;
  readonly data?: {
    readonly source?: number;
    readonly type?: number;
    readonly text?: string;
    readonly node?: RrwebNode;
  };
}
/** rrweb's id for the element with this `id` attribute in a recorded page. */
const recordedId = (node: RrwebNode | undefined, id: string): number | undefined => {
  if (node === undefined) return undefined;
  if (node.attributes?.id === id) return node.id;
  for (const child of node.childNodes ?? []) {
    const found = recordedId(child, id);
    if (found !== undefined) return found;
  }
  return undefined;
};
const eventsOf = (update: AgentBrowserUpdate): ReadonlyArray<RrwebEvent> =>
  update._tag === "events" ? (JSON.parse(update.events) as ReadonlyArray<RrwebEvent>) : [];
const decoder = new TextDecoder();
const FULL_SNAPSHOT = 2;
const INCREMENTAL = 3;
const META = 4;
const MOUSE_INTERACTION = 2;
const CLICK = 2;

describe("the agent's browser, mirrored", () => {
  it("opens workspace ports and files through this thread's preview, reminting each navigation", async () => {
    const port = Number(new URL(origin).port);
    const requests: Array<{ readonly port: number; readonly path?: string }> = [];
    const targets = [
      { port, host: "preview.example.test" },
      { port: 80, host: "preview.example.test" },
    ];
    let minted = 0;
    let personBrowserCalls = 0;
    const browser = makeRunnerBrowser(
      {
        machine: await machineTabs(),
        person: {
          newPage: async () => {
            personBrowserCalls += 1;
            throw new Error("preview navigation must not open a personal browser");
          },
          close: async () => {},
        },
      },
      {
        workspaceRoot: process.cwd(),
        allowHttpPreviewUrl: true,
        previewTargets: async () => targets,
        previewUrl: async (request) => {
          requests.push(request);
          minted += 1;
          return {
            _tag: "ready",
            url: `http://${targets.find((target) => target.port === request.port)!.host}:${port}/__signalbox/preview?ticket=secret&path=${encodeURIComponent(request.path ?? "/")}`,
          };
        },
      },
    );
    const updates = collect<AgentBrowserUpdate>();
    const viewer = browser.mirror!.watch({
      viewerId: "preview-viewer",
      tabId: null,
      send: (line) => updates.push(JSON.parse(decoder.decode(line)) as AgentBrowserUpdate),
      end: () => {},
    });
    try {
      const opened = await browser.navigate({
        target: { kind: "environment-port", port, path: "/first?tab=one#top" },
      });
      expect(opened.url).toBe(`http://preview.example.test:${port}/first?tab=one#top`);
      expect(requests[0]).toEqual({ port, path: "/first?tab=one#top" });
      const state = await updates.next(
        (update) =>
          update._tag === "state" && update.tabs.some((tab) => tab.tabId === opened.tabId),
      );
      expect(state).toMatchObject({
        _tag: "state",
        tabs: [{ tabId: opened.tabId, browser: "preview" }],
      });

      await browser.navigate({ url: opened.url! });
      expect(requests[1]).toEqual({ port, path: "/first?tab=one#top" });
      expect(minted).toBe(2);

      await browser.navigate({
        url: `${NodeURL.pathToFileURL(`${process.cwd()}/README.md`).href}?source=workspace#intro`,
      });
      expect(requests[2]).toEqual({ port: 80, path: "/README.md?source=workspace#intro" });
      expect(minted).toBe(3);
      expect(personBrowserCalls).toBe(0);
      const snapshot = await browser.snapshot({});
      expect(snapshot.networkEntries.every((entry) => !entry.url.includes("ticket="))).toBe(true);
    } finally {
      viewer.close();
      await browser.close();
    }
  }, 60_000);

  it("rejects a preview URL that does not use HTTPS outside local Workerd", async () => {
    const port = Number(new URL(origin).port);
    const browser = makeRunnerBrowser(
      { machine: await machineTabs(), person: null },
      {
        previewTargets: async () => [{ port, host: "preview.example.test" }],
        previewUrl: async () => ({ _tag: "ready", url: `http://preview.example.test:${port}/` }),
      },
    );
    try {
      await expect(browser.navigate({ url: `http://localhost:${port}/` })).rejects.toThrow(
        "different port",
      );
    } finally {
      await browser.close();
    }
  }, 60_000);

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
        tabs: [{ tabId: opened.tabId, url: `${origin}/`, browser: "preview" }],
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

      // The agent's next actions wait for the person, reads too (#579).
      const agentClick = browser.click({ locator: "role=button[name='Add']" });
      const agentRead = browser.snapshot({});
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

      viewer.input({ _tag: "release" });
      await agentClick;
      // What the page logged while the person drove never reaches the agent.
      const read = await agentRead;
      expect(read.visibleText).toContain("by script");
      expect(read.consoleEntries.map((entry) => entry.text)).not.toContain("typed Ada");
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

  it("clicks the element the person pointed at, wherever the page laid it out", async () => {
    const browser = makeRunnerBrowser(
      { machine: await machineTabs(), person: null },
      { timer: manualTimers().timer },
    );
    const updates = collect<AgentBrowserUpdate>();
    try {
      await browser.navigate({ url: `${origin}/targets` });
      const viewer = browser.mirror!.watch({
        viewerId: "viewer-1",
        tabId: null,
        send: (line) => updates.push(JSON.parse(decoder.decode(line)) as AgentBrowserUpdate),
        end: () => {},
      });
      const isSnapshot = (update: AgentBrowserUpdate) =>
        update._tag === "events" &&
        eventsOf(update).some((event) => event.type === FULL_SNAPSHOT) &&
        update.events.includes("Decoy");
      // The viewer catches up from the step's snapshot, then watching restarts the
      // recording (with canvases) from a fresh one, as the mirror page then replays.
      const caughtUp = await updates.next(isSnapshot);
      const snapshot = await updates.next(isSnapshot, updates.seen.indexOf(caughtUp) + 1);
      const node = recordedId(
        eventsOf(snapshot).find((event) => event.type === FULL_SNAPSHOT)?.data?.node,
        "target",
      );
      expect(node).toBeTypeOf("number");

      // The mirror drew Target at (20..120, 20..60). The page lays out differently
      // now, as it does when the viewer's fonts differ: Decoy is where Target was.
      await browser.evaluate({
        expression:
          "document.getElementById('target').style.left = '140px'; document.getElementById('decoy').style.left = '20px'",
      });

      viewer.input({ _tag: "take" });
      await updates.next((update) => update._tag === "state" && update.control === "you");
      const click = (target?: {
        readonly node: number;
        readonly fx: number;
        readonly fy: number;
      }) => {
        const at = { x: 70, y: 40, clickCount: 1, modifiers: 0, ...(target ? { target } : {}) };
        viewer.input({ _tag: "mouse", action: "down", button: "left", buttons: 1, ...at });
        viewer.input({ _tag: "mouse", action: "up", button: "left", buttons: 0, ...at });
      };
      const before = updates.seen.length;
      // By coordinates alone, the click lands on Decoy.
      click();
      // Aimed at Target, it lands on Target, at the same spot across its box.
      click({ node: node!, fx: 0.5, fy: 0.5 });
      // An element the page no longer has falls back to the coordinates.
      click({ node: 999_999, fx: 0.5, fy: 0.5 });
      // Hand back once the page saw all three.
      const clicks = () =>
        updates.seen
          .slice(before)
          .flatMap(eventsOf)
          .filter((event) => event.data?.source === MOUSE_INTERACTION && event.data.type === CLICK)
          .length;
      await updates.next(() => clicks() >= 3, before);
      viewer.input({ _tag: "release" });

      expect(await browser.evaluate({ expression: "window.hits" })).toEqual([
        "decoy",
        "target",
        "decoy",
      ]);
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
