import { describe, expect, it } from "@effect/vitest";

import {
  browserRequest,
  mayAttachProfile,
  profileNameOf,
  refusalFor,
  writesProfile,
} from "./browserPolicy.ts";
import { KernelApiError } from "./KernelApi.ts";

describe("the person's browser's decisions (#574)", () => {
  it("names the profile from the id's hash, never the id", () => {
    const hash = "ab".repeat(32);
    expect(profileNameOf(hash)).toBe(`sb-${"ab".repeat(16)}`);
  });

  it("attaches a profile only to its person's own turns", () => {
    expect(mayAttachProfile("user_owner", "user_owner")).toBe(true);
    expect(mayAttachProfile("user_teammate", "user_owner")).toBe(false);
  });

  it("lets one open session write the profile back at a time", () => {
    expect(writesProfile([])).toBe(true);
    expect(writesProfile([{ writer: false }])).toBe(true);
    expect(writesProfile([{ writer: true }])).toBe(false);
    // The thread's own old session is the one being replaced.
  });

  it("puts Kernel's own words, code and status in the refusal", () => {
    expect(
      refusalFor(
        new KernelApiError({
          operation: "createBrowser",
          status: 429,
          code: "org_limit_exceeded",
          message: "Concurrent browser limit reached.",
        }),
      ),
    ).toBe(
      "Kernel couldn't open a browser: Concurrent browser limit reached (org_limit_exceeded, HTTP 429).",
    );
    expect(
      refusalFor(
        new KernelApiError({
          operation: "createBrowser",
          status: 0,
          code: null,
          message: "Kernel did not answer within 30s.",
        }),
      ),
    ).toBe("Kernel couldn't open a browser: Kernel did not answer within 30s.");
  });

  it("asks Kernel for a headless stealth browser on the person's profile", () => {
    expect(browserRequest({ profileName: "sb-x", writer: false, threadId: "thread-a" })).toEqual({
      stealth: true,
      headless: true,
      timeout_seconds: 600,
      profile: { name: "sb-x", save_changes: false },
      start_url: "about:blank",
      tags: { signalbox_thread: "thread-a" },
    });
  });
});
