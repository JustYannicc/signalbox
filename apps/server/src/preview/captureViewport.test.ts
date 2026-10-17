import { chromium, type Browser, type CDPSession, type Page } from "playwright-core";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { captureViewport } from "./ServerBrowserPage.ts";

describe("viewport capture recovery", () => {
  let browser: Browser;
  let page: Page;
  let cdp: CDPSession;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });
  beforeEach(async () => {
    page = await browser.newPage();
    await page.setContent("<h1>Ready</h1>");
    cdp = await page.context().newCDPSession(page);
  });
  afterEach(async () => {
    await page.close();
  });

  it("recovers a transient Chromium capture failure and returns the actual image", async () => {
    const send = vi
      .spyOn(cdp, "send")
      .mockRejectedValueOnce(
        new Error("Protocol error (Page.captureScreenshot): Unable to capture screenshot"),
      );

    const data = await captureViewport(page, cdp, { format: "png", scale: 1 });

    expect(Buffer.from(data, "base64").subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(send.mock.calls.filter(([method]) => method === "Page.captureScreenshot")).toHaveLength(
      2,
    );
  });

  it("fails with the original error after three unsuccessful captures", async () => {
    const failure = new Error(
      "Protocol error (Page.captureScreenshot): Unable to capture screenshot",
    );
    const send = vi.spyOn(cdp, "send").mockRejectedValue(failure);

    await expect(captureViewport(page, cdp, { format: "png", scale: 1 })).rejects.toBe(failure);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("does not retry a closed target or another protocol error", async () => {
    const failure = new Error("Protocol error (Page.captureScreenshot): Target closed");
    const send = vi.spyOn(cdp, "send").mockRejectedValue(failure);

    await expect(captureViewport(page, cdp, { format: "png", scale: 1 })).rejects.toBe(failure);
    expect(send).toHaveBeenCalledOnce();
  });
});
