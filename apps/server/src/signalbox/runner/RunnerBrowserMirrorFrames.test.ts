import type { AgentBrowserStep, AgentBrowserUpdate } from "@t3tools/contracts/signalboxPreviews";
import { type Browser, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { makeRunnerBrowser, type TabSource } from "./RunnerBrowser.ts";

/**
 * Cross-origin frames in the agent's browser, as a person watches them
 * (#663): card fields sit in another origin's iframe (Stripe Elements, Adyen,
 * Braintree), which Chromium runs out of process. The frame's content has to
 * reach every snapshot the viewer and the trail replay from, and typing into
 * it shows up masked.
 */

const SHOP = "http://shop.test";
const PAY = "http://pay.test";

// Like Stripe Elements, the shop adds its card frame from script once it loaded.
const SHOP_PAGE = `<title>Checkout</title>
<style>body { margin: 0 } iframe { position: absolute; left: 20px; top: 60px; width: 300px; height: 60px; border: 0 }</style>
<label>Email <input id="email"></label>
<p>Total €35.95</p>
<script>addEventListener("load", () => document.body.append(Object.assign(document.createElement("iframe"), { id: "card-frame", src: "${PAY}/card" })));</script>`;
// Like Stripe's card field, the frame also writes the number as text beside its input.
const CARD_PAGE = `<title>Card</title>
<style>body { margin: 0 } input { width: 280px; height: 40px }</style>
<div class="field"><input id="card" name="cardnumber" autocomplete="cc-number" placeholder="Card number"><span><span id="echo"></span></span></div>
<script>card.addEventListener("input", () => { echo.textContent = card.value; });</script>`;

let chrome: Browser;

beforeAll(async () => {
  // Kernel's Chromium isolates every site in its own process; make sure this one does too.
  chrome = await chromium.launch({ headless: true, args: ["--site-per-process"] });
}, 60_000);

afterAll(async () => {
  await chrome?.close();
});

const shopTabs = async (): Promise<TabSource> => {
  const context = await chrome.newContext();
  await context.route(`${SHOP}/**`, (route) =>
    route.fulfill({ contentType: "text/html", body: SHOP_PAGE }),
  );
  await context.route(`${PAY}/**`, (route) =>
    route.fulfill({ contentType: "text/html", body: CARD_PAGE }),
  );
  return { newPage: () => context.newPage(), close: () => context.close() };
};

/** The card frame in the tab the agent opened. */
const cardFrame = async () => {
  const page = chrome.contexts().flatMap((context) => context.pages())[0]!;
  const frame = page.frames().find((each) => each.url().startsWith(PAY));
  if (frame !== undefined) return frame;
  return page.waitForEvent("framenavigated", { predicate: (each) => each.url().startsWith(PAY) });
};

/** Everything a stream carries, and a way to wait for the moment the test needs next. */
const collect = <A>() => {
  const seen: Array<A> = [];
  const waiting = new Set<{ readonly test: () => boolean; readonly resolve: () => void }>();
  return {
    seen,
    push: (item: A) => {
      seen.push(item);
      for (const wait of waiting)
        if (wait.test()) {
          waiting.delete(wait);
          wait.resolve();
        }
    },
    until: (test: () => boolean) =>
      test() ? Promise.resolve() : new Promise<void>((resolve) => waiting.add({ test, resolve })),
  };
};

interface RrwebEvent {
  readonly type: number;
  readonly data?: {
    readonly source?: number;
    readonly text?: string;
    readonly isAttachIframe?: boolean;
    readonly adds?: ReadonlyArray<{ readonly node: { readonly id: number } }>;
  };
}
const FULL_SNAPSHOT = 2;
const INCREMENTAL = 3;
const INPUT = 5;
const MUTATION = 0;
const decoder = new TextDecoder();

const eventsOf = (updates: ReadonlyArray<AgentBrowserUpdate>): ReadonlyArray<RrwebEvent> =>
  updates.flatMap((update) =>
    update._tag === "events" ? (JSON.parse(update.events) as ReadonlyArray<RrwebEvent>) : [],
  );

/** The events a replay shows now: those from the latest full snapshot on. */
const sinceSnapshot = (events: ReadonlyArray<RrwebEvent>) =>
  events.slice(events.findLastIndex((event) => event.type === FULL_SNAPSHOT));

/** The card frame's document is in the replay: attached under the shop's iframe. */
const showsCardFrame = (events: ReadonlyArray<RrwebEvent>) =>
  sinceSnapshot(events).some(
    (event) =>
      event.type === INCREMENTAL &&
      event.data?.isAttachIframe === true &&
      JSON.stringify(event).includes("cc-number"),
  );

/** Each child document is forwarded once, even when snapshot responses arrive together. */
const attachedDocumentsPerSnapshot = (events: ReadonlyArray<RrwebEvent>) => {
  const documents: Array<Array<number>> = [];
  for (const event of events)
    if (event.type === FULL_SNAPSHOT) documents.push([]);
    else if (
      documents.length > 0 &&
      event.data?.isAttachIframe === true &&
      JSON.stringify(event).includes("cc-number")
    )
      documents[documents.length - 1]!.push(...(event.data.adds ?? []).map((add) => add.node.id));
  return documents;
};

describe("cross-origin frames in the agent's browser", () => {
  it("replays a card frame and what the person types into it, masked", async () => {
    const browser = makeRunnerBrowser({ machine: await shopTabs(), person: null });
    const steps: Array<{ readonly step: AgentBrowserStep; readonly events: string }> = [];
    browser.mirror!.onStep((step, events) => steps.push({ step, events }));
    const updates = collect<AgentBrowserUpdate>();
    try {
      await browser.navigate({ url: `${SHOP}/` });
      // The frame recorded its document before anyone watched.
      await (await cardFrame()).waitForSelector("#card");

      let viewer = browser.mirror!.watch({
        viewerId: "viewer-1",
        tabId: null,
        send: (line) => updates.push(JSON.parse(decoder.decode(line)) as AgentBrowserUpdate),
        end: () => {},
      });
      // Watching restarts the recording (with canvases) from a fresh snapshot,
      // and the card frame has to come with it.
      await updates.until(() => showsCardFrame(eventsOf(updates.seen)));

      // An agent action ends a step on a fresh snapshot too: the trail keeps the frame.
      await browser.click({ locator: "#email" });
      await updates.until(() => {
        const events = eventsOf(updates.seen);
        return steps.some((each) => each.step.action === "click") && showsCardFrame(events);
      });
      const click = steps.find((each) => each.step.action === "click")!;
      expect(showsCardFrame(JSON.parse(click.events) as ReadonlyArray<RrwebEvent>)).toBe(true);

      // Hold two real snapshot requests until both canvas restarts finish. Their
      // replies then belong to the same parent snapshot, regardless of process timing.
      const held = await (
        await cardFrame()
      ).evaluateHandle<{ release: () => Promise<void> }>(`(() => {
        const requests = [];
        const { promise: queued, resolve: ready } = Promise.withResolvers();
        const hold = (event) => {
          if (event.source !== parent || !event.data || !Object.values(event.data).includes("snapshot")) return;
          event.stopImmediatePropagation();
          requests.push(event);
          if (requests.length === 2) ready();
        };
        addEventListener("message", hold, true);
        return {
          release: async () => {
            await queued;
            removeEventListener("message", hold, true);
            for (const event of requests)
              dispatchEvent(new MessageEvent("message", { data: event.data, origin: event.origin, source: event.source }));
          },
        };
      })()`);
      viewer.close();
      viewer = browser.mirror!.watch({
        viewerId: "viewer-2",
        tabId: null,
        send: (line) => updates.push(JSON.parse(decoder.decode(line)) as AgentBrowserUpdate),
        end: () => {},
      });
      await held.evaluate((gate) => gate.release());
      await held.dispose();
      await updates.until(
        () => (attachedDocumentsPerSnapshot(eventsOf(updates.seen)).at(-1)?.length ?? 0) >= 2,
      );

      // Distinct child snapshots may land after the same parent snapshot. Stale
      // recorder listeners must not forward the same child document twice.
      for (const documents of attachedDocumentsPerSnapshot(eventsOf(updates.seen)))
        expect(documents).toEqual([...new Set(documents)]);

      // The person types a card number into the frame; the mirror shows it masked.
      viewer.input({ _tag: "take" });
      await updates.until(() =>
        updates.seen.some((update) => update._tag === "state" && update.control === "you"),
      );
      const typed = updates.seen.length;
      const at = { x: 160, y: 80, clickCount: 1, modifiers: 0 } as const;
      viewer.input({ _tag: "mouse", action: "down", button: "left", buttons: 1, ...at });
      viewer.input({ _tag: "mouse", action: "up", button: "left", buttons: 0, ...at });
      viewer.input({ _tag: "text", text: "4242" });
      await updates.until(() =>
        eventsOf(updates.seen.slice(typed)).some(
          (event) =>
            event.type === INCREMENTAL &&
            event.data?.source === INPUT &&
            event.data.text === "****",
        ),
      );
      // The number the frame writes as text beside its field reaches the viewer too.
      await updates.until(() =>
        eventsOf(updates.seen.slice(typed)).some(
          (event) =>
            event.type === INCREMENTAL &&
            event.data?.source === MUTATION &&
            /\*{4}|4242/.test(JSON.stringify(event)),
        ),
      );
      viewer.input({ _tag: "release" });

      expect(await (await cardFrame()).inputValue("#card")).toBe("4242");
      // The digits themselves never reach a viewer.
      expect(
        updates.seen.some((update) => update._tag === "events" && update.events.includes("4242")),
      ).toBe(false);
      // The shop's own figures stay readable.
      expect(
        updates.seen.some((update) => update._tag === "events" && update.events.includes("35.95")),
      ).toBe(true);
    } finally {
      await browser.close();
    }
  }, 60_000);
});
