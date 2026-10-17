// @effect-diagnostics nodeBuiltinImport:off - execute the delivered browser script at its runtime boundary.
import * as NodeVM from "node:vm";

import { afterEach, describe, expect, it, vi } from "@effect/vitest";

import { previewScript } from "./previewPage.ts";

const browser = async () => {
  const sockets: Array<{
    onopen?: () => void;
    onclose?: (event: { code: number }) => void;
    close: () => void;
  }> = [];
  const message = { textContent: "Starting preview…" };
  const retry = { hidden: true, addEventListener: () => undefined };
  const location = { protocol: "https:", host: "preview.example", reload: vi.fn() };
  const listeners = new Map<string, (event: { persisted: boolean }) => void>();
  const WebSocket = class {
    onopen?: () => void;
    onclose?: (event: { code: number }) => void;
    constructor() {
      sockets.push(this);
    }
    send() {
      /* The lease heartbeat has no app payload. */
    }
    close() {
      this.onclose?.({ code: 1000 });
    }
  };
  NodeVM.runInNewContext(await previewScript().text(), {
    window: {},
    document: {
      documentElement: { dataset: { signalboxStarting: "true" } },
      querySelector: (selector: string) =>
        selector === "[data-preview-message]" ? message : retry,
    },
    location,
    WebSocket,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    addEventListener: (event: string, listener: (value: { persisted: boolean }) => void) => {
      listeners.set(event, listener);
    },
  });
  return { sockets, message, retry, location, listeners };
};
afterEach(() => vi.useRealTimers());

describe("the preview tab lease", () => {
  it("stops retrying after a startup deadline and offers an explicit retry", async () => {
    vi.useFakeTimers();
    const page = await browser();
    page.sockets[0]!.onopen!();
    expect(page.sockets).toHaveLength(1);
    vi.advanceTimersByTime(180_000);
    expect(page.message.textContent).toBe("The preview is taking too long. Try again.");
    expect(page.retry.hidden).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(page.sockets).toHaveLength(1);
  });
});
