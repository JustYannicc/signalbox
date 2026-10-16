import { describe, expect, it } from "@effect/vitest";

import { browserFor } from "./RunnerBrowserRoute.ts";

describe("browserFor", () => {
  it("keeps the thread's own machine on the headless browser", () => {
    for (const url of [
      "http://localhost:5173/",
      "https://localhost:3000/settings",
      "http://app.localhost:8080",
      "http://127.0.0.1:4173",
      "http://127.8.0.1",
      "http://[::1]:5173/",
      "http://0.0.0.0:3000",
      "http://10.0.0.12:8080",
      "http://172.20.1.4",
      "http://192.168.1.10",
      "http://169.254.169.254",
      "http://devserver:3000",
      "http://host.docker.internal:5173",
      "http://localhost.:5173",
      "http://[::ffff:127.0.0.1]:5173",
      "http://[fd00::1]:3000",
      "http://printer.local",
      "about:blank",
      "data:text/html,<p>hi</p>",
      "file:///tmp/report.html",
    ]) {
      expect(browserFor(url), url).toBe("machine");
    }
  });

  it("sends every other host to the person's browser", () => {
    for (const url of [
      "https://github.com/JustYannicc/signalbox",
      "https://www.booking.com",
      "http://example.com:8080/",
      "https://172.32.0.1",
      "https://8.8.8.8",
      "https://[2606:4700::1111]/",
      "https://localhost.example.com",
    ]) {
      expect(browserFor(url), url).toBe("person");
    }
  });

  it("treats an unparsable URL as the machine's, so it never reaches the person's browser", () => {
    expect(browserFor("not a url")).toBe("machine");
  });
});
