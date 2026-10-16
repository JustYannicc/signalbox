import type { AutomationRunStatus } from "@t3tools/contracts";
import type { AgentBrowserUpdate } from "@t3tools/contracts/signalboxPreviews";
import { type Browser, type BrowserContext, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { type BrowserBackend, makeRunnerBrowser, type TabSource } from "./RunnerBrowser.ts";
import { AGENT_WAIT_MS, PAYMENT_WAITING } from "./RunnerBrowserControl.ts";
import {
  ALREADY_ANSWERED,
  makePayments,
  NOT_A_PAYMENT,
  PAYMENT_PATIENCE_MS,
  PAYMENT_POLL_MS,
  type PaymentAsker,
  pageKind,
  REACHED_PAYMENT,
} from "./RunnerBrowserPayment.ts";
import { manualTimers } from "./runnerBrowserTesting.ts";

/**
 * Payments go back to the person (#579), on a real Chromium. Sites are served
 * through Playwright's routing under made-up public hosts, so they open in the
 * "person's" browser as real sites do; the automation that asks the person is
 * faked, and the person's answer is set on it by hand.
 */

const CARD = `<input autocomplete="cc-number" autofocus aria-label="Card number">`;
const SITES: Record<string, string> = {
  "https://shop.test/product": `<title>Kettle</title><a href="/checkout">Checkout</a>`,
  "https://shop.test/checkout": `<title>Pay</title><form>${CARD}<button type="button">Pay 12 CHF</button></form>`,
  "https://shop.test/review": `<title>Review</title><button>Place order</button>`,
  "https://shop.test/thanks": `<title>Thanks</title><p>Order placed</p>`,
  "https://shop.test/hidden-card": `<title>Hidden</title><input autocomplete="cc-number" style="display:none">`,
  "https://shop.test/card-frame": `<title>Elements</title><iframe src="https://js.payments.test/inner-card"></iframe>`,
  "https://js.payments.test/inner-card": `<input name="cardnumber" aria-label="Card">`,
  "https://shop.test/3ds-frame": `<title>Confirm</title><iframe src="https://hooks.payments.test/3d_secure_2/authenticate"></iframe>`,
  "https://hooks.payments.test/3d_secure_2/authenticate": `<p>Approve in your banking app</p>`,
  "https://acs.bank.test/challenge": `<title>Your bank</title><p>Approve this payment</p>`,
  "https://shop.test/products/3ds-max": `<title>3ds Max</title><p>Modelling software</p>`,
  "https://shop.test/login": `<title>Sign in</title><input type="email"><input type="password" aria-label="Password">`,
  "https://shop.test/code": `<title>Code</title><input autocomplete="one-time-code">`,
  "https://shop.test/robot": `<title>Robot?</title><iframe src="https://www.google.com/recaptcha/api2/anchor"></iframe>`,
  "https://www.google.com/recaptcha/api2/anchor": `<p>I'm not a robot</p>`,
};

let chrome: Browser;

beforeAll(async () => {
  chrome = await chromium.launch({ headless: true });
}, 60_000);

afterAll(async () => {
  await chrome?.close();
});

const siteContext = async (): Promise<BrowserContext> => {
  const context = await chrome.newContext();
  await context.route("**/*", (route) => {
    const url = route.request().url().replace(/\/$/, "");
    const body = SITES[url];
    return body === undefined
      ? route.fulfill({ status: 404, body: "" })
      : route.fulfill({ contentType: "text/html", body });
  });
  return context;
};

const sources = async () => {
  const machine = await chrome.newContext();
  const person = await siteContext();
  const source = (context: BrowserContext): TabSource => ({
    newPage: () => context.newPage(),
    close: () => context.close(),
  });
  return { machine: source(machine), person: source(person) };
};

/** The "Payment" automation's runs, answered by hand. */
const fakeAsker = () => {
  const runs = new Map<string, { status: AutomationRunStatus; output: unknown }>();
  const started: Array<Parameters<PaymentAsker["start"]>> = [];
  const cancelled: Array<string> = [];
  let refuse: string | null = null;
  const asker: PaymentAsker = {
    start: async (...args) => {
      if (refuse !== null) throw new Error(refuse);
      started.push(args);
      const runId = `run-${started.length}`;
      runs.set(runId, { status: "running", output: null });
      return runId;
    },
    read: async (runId) => runs.get(runId) ?? { status: "failed", output: null },
    cancel: async (runId) => {
      cancelled.push(runId);
      runs.set(runId, { status: "cancelled", output: null });
    },
  };
  return {
    asker,
    started,
    cancelled,
    answer: (runId: string, outcome: "done" | "failed", note: string | null) =>
      runs.set(runId, { status: "succeeded", output: { outcome, note } }),
    refuse: (why: string) => {
      refuse = why;
    },
  };
};

const decoder = new TextDecoder();

/** A viewer of the agent's browser, keeping every update. */
const watch = (browser: BrowserBackend) => {
  const seen: Array<AgentBrowserUpdate> = [];
  const listeners = new Set<() => void>();
  const viewer = browser.mirror!.watch({
    viewerId: "viewer-1",
    tabId: null,
    send: (line) => {
      seen.push(JSON.parse(decoder.decode(line)) as AgentBrowserUpdate);
      for (const listener of listeners) listener();
    },
    end: () => {},
  });
  const next = (test: (update: AgentBrowserUpdate) => boolean) =>
    new Promise<AgentBrowserUpdate>((resolve) => {
      const check = () => {
        const found = seen.find(test);
        if (found === undefined) return;
        listeners.delete(check);
        resolve(found);
      };
      listeners.add(check);
      check();
    });
  return { viewer, seen, next };
};

const setup = async () => {
  const timers = manualTimers();
  const asking = fakeAsker();
  const payments = makePayments({ asker: asking.asker, timer: timers.timer });
  const browser = makeRunnerBrowser(await sources(), {
    timer: timers.timer,
    guard: payments.guard,
  });
  payments.bind(browser);
  return { timers, asking, payments, browser };
};

describe("pageKind", () => {
  it("knows payments by card fields and 3-D Secure checks, and never takes a sign-in or CAPTCHA for one", async () => {
    const context = await siteContext();
    const page = await context.newPage();
    const kindAt = async (url: string) => {
      await page.goto(url, { waitUntil: "load" });
      return pageKind(page);
    };
    try {
      expect(await kindAt("https://shop.test/checkout")).toBe("payment");
      // Card fields inside another origin's frame, as Stripe Elements puts them.
      expect(await kindAt("https://shop.test/card-frame")).toBe("payment");
      expect(await kindAt("https://shop.test/3ds-frame")).toBe("payment");
      expect(await kindAt("https://acs.bank.test/challenge")).toBe("payment");

      expect(await kindAt("https://shop.test/login")).toBe("sign-in");
      expect(await kindAt("https://shop.test/code")).toBe("sign-in");
      expect(await kindAt("https://shop.test/robot")).toBe("captcha");

      expect(await kindAt("https://shop.test/review")).toBe("other");
      expect(await kindAt("https://shop.test/hidden-card")).toBe("other");
      // "3ds" in a shop's own address is a product, not a check.
      expect(await kindAt("https://shop.test/products/3ds-max")).toBe("other");
    } finally {
      await context.close();
    }
  }, 60_000);
});

describe("a payment handed to the person", () => {
  it("hands a checkout over by itself, reads nothing while the person pays, and resumes after Done", async () => {
    const { timers, asking, payments, browser } = await setup();
    const { viewer, seen, next } = watch(browser);
    try {
      await browser.navigate({ url: "https://shop.test/product" });
      // The click lands on the checkout: the agent hears it's the person's now.
      await expect(browser.click({ locator: "role=link[name='Checkout']" })).rejects.toThrow(
        REACHED_PAYMENT,
      );
      expect(asking.started).toEqual([
        [expect.any(String), { site: "shop.test", note: null, ownBrowserUrl: null }],
      ]);
      await next(
        (update) =>
          update._tag === "state" &&
          update.handoff?.runId === "run-1" &&
          update.handoff.site === "shop.test",
      );
      expect((await browser.status({})).control).toMatchObject({ owner: "human" });

      // Neither the tool nor reads get anything until the person answers.
      const first = payments.request({});
      await timers.armed(AGENT_WAIT_MS);
      timers.fire(AGENT_WAIT_MS);
      expect(await first).toMatchObject({ status: "waiting" });
      const read = browser.snapshot({});
      await timers.armed(AGENT_WAIT_MS);
      timers.fire(AGENT_WAIT_MS);
      await expect(read).rejects.toThrow(PAYMENT_WAITING);

      // The person types the card through the mirror; it's masked there and in the trail.
      viewer.input({ _tag: "take" });
      await next((update) => update._tag === "state" && update.control === "you");
      viewer.input({ _tag: "text", text: "4242424242424242" });
      await next(
        (update) => update._tag === "events" && update.events.includes("****************"),
      );
      expect(seen.some((update) => JSON.stringify(update).includes("4242424242424242"))).toBe(
        false,
      );

      // Done: the next call hears it, and the tab is the agent's again.
      asking.answer("run-1", "done", "Paid 12 CHF");
      const second = payments.request({});
      await timers.armed(PAYMENT_POLL_MS);
      timers.fire(PAYMENT_POLL_MS);
      expect(await second).toMatchObject({ status: "done", note: "Paid 12 CHF" });
      await next((update) => update._tag === "state" && update.handoff === null);
      expect((await browser.status({})).control).toMatchObject({ owner: "agent" });
      expect((await browser.snapshot({})).title).toBe("Pay");
      expect(asking.cancelled).toEqual([]);

      // The person answered: the agent can't pay on that page itself, only ask again.
      await expect(browser.click({ locator: "role=button[name='Pay 12 CHF']" })).rejects.toThrow(
        ALREADY_ANSWERED,
      );
      const again = payments.request({});
      await timers.armed(AGENT_WAIT_MS);
      expect(asking.started).toHaveLength(2);
      timers.fire(AGENT_WAIT_MS);
      expect(await again).toMatchObject({ status: "waiting" });
    } finally {
      viewer.close();
      await payments.close();
      await browser.close();
    }
  }, 60_000);

  it("hands over a payment the agent names, with the person's own browser offered for an account's cart", async () => {
    const { timers, asking, payments, browser } = await setup();
    try {
      await browser.navigate({ url: "https://shop.test/review" });
      const waiting = payments.request({ note: "Kettle, 12 CHF", savedToAccount: true });
      await timers.armed(AGENT_WAIT_MS);
      expect(asking.started).toEqual([
        [
          expect.any(String),
          {
            site: "shop.test",
            note: "Kettle, 12 CHF",
            ownBrowserUrl: "https://shop.test/review",
          },
        ],
      ]);
      asking.answer("run-1", "failed", "Card declined");
      timers.fire(PAYMENT_POLL_MS);
      expect(await waiting).toMatchObject({ status: "failed", note: "Card declined" });
      // Calling again starts a new payment, not the old outcome.
      expect(asking.started).toHaveLength(1);
    } finally {
      await payments.close();
      await browser.close();
    }
  }, 60_000);

  it("never hands over a sign-in, and lets the agent act on it", async () => {
    const { asking, payments, browser } = await setup();
    try {
      await browser.navigate({ url: "https://shop.test/login" });
      await expect(payments.request({})).rejects.toThrow(NOT_A_PAYMENT);
      await browser.type({ locator: "role=textbox[name='Password']", text: "x" });
      expect(asking.started).toEqual([]);
      expect((await browser.status({})).control).toMatchObject({ owner: "agent" });
    } finally {
      await payments.close();
      await browser.close();
    }
  }, 60_000);

  it("gives the tab back when nobody can be asked, and says so", async () => {
    const { asking, payments, browser } = await setup();
    try {
      await browser.navigate({ url: "https://shop.test/review" });
      asking.refuse("no running turn");
      await expect(payments.request({})).rejects.toThrow(/couldn't ask the person to pay/);
      expect((await browser.status({})).control).toMatchObject({ owner: "agent" });
    } finally {
      await payments.close();
      await browser.close();
    }
  }, 60_000);

  it("withdraws a payment nobody answered for 30 minutes", async () => {
    const { timers, asking, payments, browser } = await setup();
    try {
      await browser.navigate({ url: "https://shop.test/review" });
      const waiting = payments.request({});
      await timers.armed(PAYMENT_PATIENCE_MS);
      timers.fire(PAYMENT_PATIENCE_MS);
      expect(await waiting).toMatchObject({ status: "failed" });
      expect(asking.cancelled).toEqual(["run-1"]);
      expect((await browser.status({})).control).toMatchObject({ owner: "agent" });
    } finally {
      await payments.close();
      await browser.close();
    }
  }, 60_000);
});
