import { describe, expect, it } from "vite-plus/test";

import { serviceIdentity } from "./services.ts";

describe("serviceIdentity", () => {
  it("finds a logo for providers, services and hosts", () => {
    expect(serviceIdentity("codex")).toMatchObject({ kind: "provider", name: "Codex" });
    expect(serviceIdentity("claude")).toMatchObject({ kind: "provider", provider: "claudeAgent" });
    expect(serviceIdentity("antigravity")).toMatchObject({ kind: "provider", name: "Antigravity" });
    expect(serviceIdentity("pi")).toMatchObject({ kind: "provider", name: "Pi" });
    expect(serviceIdentity("sentry")).toMatchObject({ kind: "domain", domain: "sentry.io" });
    expect(serviceIdentity("stripe")).toMatchObject({
      kind: "domain",
      domain: "stripe.com",
      name: "Stripe",
    });
    expect(serviceIdentity("api.github.com")).toMatchObject({
      kind: "domain",
      domain: "github.com",
    });
    expect(serviceIdentity(undefined)).toBeNull();
  });
});
