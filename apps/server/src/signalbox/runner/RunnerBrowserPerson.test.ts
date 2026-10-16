// @effect-diagnostics nodeBuiltinImport:off - runs a real Chromium over CDP and the pages it opens.
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";

import type { BrowserSessionAnswer } from "@signalbox/runner-protocol/BrowserProtocol";
import { type Browser, chromium } from "playwright-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";

import { type BrowserBackend, makeRunnerBrowser, type TabSource } from "./RunnerBrowser.ts";
import { personTabs } from "./RunnerBrowserPerson.ts";

/**
 * The person's browser stands in for Kernel as a second Chromium reached
 * over CDP, the way Kernel's `cdp_ws_url` is, with a "profile" cookie for
 * `site.test`. One page server echoes the cookies each request carries, so a
 * dev tab that carried the profile would show it.
 */

const RESOLVE = "--host-resolver-rules=MAP site.test 127.0.0.1";

let server: NodeHttp.Server;
let port = 0;
const cookiesSeen: Array<{ host: string; cookie: string }> = [];
let person: Browser;
let cdpWsUrl = "";
let machineBrowser: Browser;

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = NodeNet.createServer().listen(0, "127.0.0.1", () => {
      const { port: free } = probe.address() as { port: number };
      probe.close(() => resolve(free));
    });
  });

beforeAll(async () => {
  server = NodeHttp.createServer((request, response) => {
    const cookie = request.headers.cookie ?? "none";
    cookiesSeen.push({ host: request.headers.host ?? "", cookie });
    response.setHeader("content-type", "text/html");
    response.end(`<title>${request.headers.host}</title><p>cookie: ${cookie}</p>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;

  const debugPort = await freePort();
  person = await chromium.launch({
    headless: true,
    args: [RESOLVE, `--remote-debugging-port=${debugPort}`],
  });
  // Kernel hands out a ws:// endpoint; Playwright reads this one from the port.
  cdpWsUrl = `http://127.0.0.1:${debugPort}`;
  // The person signed in to site.test earlier: that is what their profile holds.
  const seed = await chromium.connectOverCDP(cdpWsUrl);
  await seed
    .contexts()[0]!
    .addCookies([{ name: "profile", value: "signed-in", domain: "site.test", path: "/" }]);
  await seed.close();

  machineBrowser = await chromium.launch({ headless: true, args: [RESOLVE] });
}, 60_000);

// Each thread gets its own Kernel session; here they share one, so each test starts with no tabs.
beforeEach(async () => {
  const cleaner = await chromium.connectOverCDP(cdpWsUrl);
  await Promise.all(
    cleaner
      .contexts()[0]!
      .pages()
      .map((page) => page.close()),
  );
  await cleaner.close();
});

afterAll(async () => {
  await machineBrowser?.close();
  await person?.close();
  server?.close();
});

/** The machine's browser: a fresh storage-less context, as the Runner's is. */
const machineTabs = async (): Promise<TabSource> => {
  const context = await machineBrowser.newContext();
  return { newPage: () => context.newPage(), close: () => context.close() };
};

const sessions = (answer: () => BrowserSessionAnswer) => {
  const calls = { open: 0, ended: [] as Array<string> };
  return {
    calls,
    session: {
      open: async () => {
        calls.open += 1;
        return answer();
      },
      end: async (sessionId: string) => {
        calls.ended.push(sessionId);
      },
    },
  };
};

const ready = (): BrowserSessionAnswer => ({ _tag: "ready", sessionId: "brw_1", cdpWsUrl });

const cookieOn = async (browser: BrowserBackend, tabId: string) =>
  /cookie: (.*)/.exec((await browser.snapshot({ tabId })).visibleText)?.[1];

describe("the thread's browser with the person's", () => {
  it("opens real sites signed in as the person and dev servers with nobody's cookies", async () => {
    const { session } = sessions(ready);
    const browser = makeRunnerBrowser({
      machine: await machineTabs(),
      person: personTabs(session),
    });
    try {
      const site = await browser.navigate({ url: `http://site.test:${port}/` });
      expect(await cookieOn(browser, site.tabId!)).toBe("profile=signed-in");

      const dev = await browser.open({ url: `http://localhost:${port}/`, reuseExistingTab: false });
      expect(dev.tabId).not.toBe(site.tabId);
      expect(await cookieOn(browser, dev.tabId!)).toBe("none");

      // The real site's tab going to the dev server moves to the machine, under the same id.
      const moved = await browser.navigate({
        tabId: site.tabId!,
        url: `http://localhost:${port}/moved`,
      });
      expect(moved.tabId).toBe(site.tabId);
      expect(await cookieOn(browser, site.tabId!)).toBe("none");
      const back = await browser.navigate({ tabId: site.tabId!, url: `http://site.test:${port}/` });
      expect(back.tabId).toBe(site.tabId);
      expect(await cookieOn(browser, site.tabId!)).toBe("profile=signed-in");
      expect((await browser.status({})).tabs?.map((tab) => tab.tabId).toSorted()).toEqual(
        [site.tabId, dev.tabId].toSorted(),
      );

      expect(
        cookiesSeen.filter((seen) => seen.host.startsWith("localhost")).map((seen) => seen.cookie),
      ).not.toContain("profile=signed-in");
    } finally {
      await browser.close();
    }
  }, 60_000);

  it("lets go when idle and finds its tabs again on the next real site", async () => {
    const { session, calls } = sessions(ready);
    let drop: (() => Promise<void>) | null = null;
    const browser = makeRunnerBrowser({
      machine: await machineTabs(),
      person: personTabs(session, {
        onIdle: (next) => {
          drop = next;
          return () => {
            drop = null;
          };
        },
      }),
    });
    try {
      const first = await browser.navigate({ url: `http://site.test:${port}/first` });
      await drop!();
      expect((await browser.status({})).tabs).toEqual([]);

      // The tab the agent kept comes back under its id, and stays the current tab.
      expect(await cookieOn(browser, first.tabId!)).toBe("profile=signed-in");
      expect(calls.open).toBe(2);
      await drop!();
      expect((await browser.snapshot({})).url).toBe(`http://site.test:${port}/first`);
      expect(calls.open).toBe(3);

      const second = await browser.open({
        url: `http://site.test:${port}/second`,
        reuseExistingTab: false,
      });
      expect((await browser.status({})).tabs?.map((tab) => [tab.tabId, tab.url])).toEqual([
        [first.tabId, `http://site.test:${port}/first`],
        [second.tabId, `http://site.test:${port}/second`],
      ]);
    } finally {
      await browser.close();
    }
    // Closing the thread's browser deletes the session, which saves the profile.
    expect(calls.ended).toEqual(["brw_1"]);
  }, 60_000);

  it("tells the agent why the person's browser can't open, and keeps the machine's working", async () => {
    const { session } = sessions(() => ({
      _tag: "refused",
      message: "Kernel couldn't open a browser: org_limit_exceeded",
    }));
    const browser = makeRunnerBrowser({
      machine: await machineTabs(),
      person: personTabs(session),
    });
    try {
      await expect(browser.navigate({ url: `http://site.test:${port}/` })).rejects.toThrow(
        "org_limit_exceeded",
      );
      const dev = await browser.navigate({ url: `http://localhost:${port}/` });
      expect(await cookieOn(browser, dev.tabId!)).toBe("none");
    } finally {
      await browser.close();
    }
  }, 60_000);

  it("opens real sites on the machine when the cloud has no person's browser", async () => {
    const { session } = sessions(() => ({ _tag: "unconfigured" }));
    const browser = makeRunnerBrowser({
      machine: await machineTabs(),
      person: personTabs(session),
    });
    try {
      const site = await browser.navigate({ url: `http://site.test:${port}/` });
      expect(await cookieOn(browser, site.tabId!)).toBe("none");
    } finally {
      await browser.close();
    }
  }, 60_000);
});
