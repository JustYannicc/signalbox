import { describe, expect, it } from "@effect/vitest";

import { askSiteOf, grantSiteOf, hostOf, narrowestCovering } from "./signInSites.ts";

describe("sign-in sites", () => {
  it("keeps the host of whatever the person types", () => {
    expect(grantSiteOf("example.com")).toBe("example.com");
    expect(grantSiteOf("  Example.COM.  ")).toBe("example.com");
    expect(grantSiteOf("https://accounts.example.com:8443/login?next=/")).toBe(
      "accounts.example.com",
    );
    // "www." is the site itself: granting it covers the bare domain and its other hosts.
    expect(grantSiteOf("www.booking.com")).toBe("booking.com");
    expect(grantSiteOf("http://bücher.example")).toBe("xn--bcher-kva.example");
    expect(grantSiteOf("*")).toBe("*");
    expect(grantSiteOf("203.0.113.7")).toBe("203.0.113.7");
  });

  it("refuses what isn't one site", () => {
    for (const input of [
      "",
      "   ",
      "com",
      "co.uk",
      // A public suffix that anyone can host under is many sites, not one.
      "github.io",
      "localhost",
      "intranet",
      "*.example.com",
      "ftp://example.com",
      "not a site",
    ]) {
      expect(grantSiteOf(input), input).toBeNull();
    }
  });

  it("reads the host of a page that needs a sign-in", () => {
    expect(hostOf("https://account.booking.com/sign-in")).toBe("account.booking.com");
    expect(hostOf("https://WWW.Example.com")).toBe("www.example.com");
    expect(hostOf("booking.com")).toBe("booking.com");
    expect(hostOf("about:blank")).toBeNull();
    expect(hostOf("file:///etc/passwd")).toBeNull();
    expect(hostOf("https://")).toBeNull();
  });

  it("asks about the address a site's accounts share", () => {
    expect(askSiteOf("account.booking.com")).toBe("booking.com");
    expect(askSiteOf("www.example.co.uk")).toBe("example.co.uk");
    // Each project on a shared host is its own site.
    expect(askSiteOf("someone.github.io")).toBe("someone.github.io");
    expect(askSiteOf("203.0.113.7")).toBe("203.0.113.7");
    // No grant could cover these, so nothing offers one.
    expect(askSiteOf("localhost")).toBeNull();
    expect(askSiteOf("github.io")).toBeNull();
  });

  it("covers a host and the hosts below it, never a lookalike", () => {
    const grants = [
      { id: "everywhere", site: "*" },
      { id: "booking", site: "booking.com" },
      { id: "account", site: "account.booking.com" },
      { id: "ip", site: "203.0.113.7" },
    ];
    const without = (id: string) => grants.filter((grant) => grant.id !== id);

    // The narrowest grant names why it's allowed, so revoking it is the obvious next step.
    expect(narrowestCovering(grants, "account.booking.com")?.id).toBe("account");
    expect(narrowestCovering(grants, "secure.booking.com")?.id).toBe("booking");
    expect(narrowestCovering(grants, "booking.com")?.id).toBe("booking");
    expect(narrowestCovering(grants, "203.0.113.7")?.id).toBe("ip");
    expect(narrowestCovering(grants, "example.com")?.id).toBe("everywhere");

    const perSite = without("everywhere");
    expect(narrowestCovering(perSite, "booking.com.evil.test")).toBeNull();
    expect(narrowestCovering(perSite, "notbooking.com")).toBeNull();
    expect(narrowestCovering(perSite, "113.7")).toBeNull();
    expect(narrowestCovering(perSite, "1.203.0.113.7")).toBeNull();
    expect(narrowestCovering([], "booking.com")).toBeNull();
  });
});
