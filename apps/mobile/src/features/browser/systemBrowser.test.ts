import { describe, expect, it } from "vite-plus/test";

import { opensInSystemBrowser } from "./systemBrowser";

describe("opensInSystemBrowser", () => {
  it("sends Google's own pages to the system browser view and keeps everything else here", () => {
    expect(opensInSystemBrowser("https://docs.google.com/document/d/abc/edit")).toBe(true);
    expect(opensInSystemBrowser("https://accounts.google.com/signin")).toBe(true);
    expect(opensInSystemBrowser("https://google.com/")).toBe(true);
    expect(opensInSystemBrowser("https://notgoogle.com/")).toBe(false);
    expect(opensInSystemBrowser("https://google.com.evil.test/")).toBe(false);
    expect(opensInSystemBrowser("https://booking.com/")).toBe(false);
    expect(opensInSystemBrowser("mailto:me@google.com")).toBe(false);
    expect(opensInSystemBrowser(null)).toBe(false);
  });
});
