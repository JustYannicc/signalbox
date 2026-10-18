import { describe, expect, it } from "@effect/vitest";

import { scrubTraceAttributes, scrubTraceUrl } from "./traceUrlScrubbing.ts";

describe("trace URL scrubbing", () => {
  it("drops URL query and fragment data while preserving surrounding metadata", () => {
    const attributes = {
      "service.name": "relay-client",
      "url.query": "code=oauth-code&state=oauth-state&access_token=access-token",
      "url.full":
        "https://user:password@auth.example.test/callback?code=oauth-code#id_token=id-token",
      nested: [
        {
          "http.url":
            "https://auth.example.test/token?refresh_token=refresh-token&client_secret=client-secret",
          "request.id": "request-123",
        },
      ],
    };

    expect(scrubTraceAttributes(attributes)).toEqual({
      "service.name": "relay-client",
      "url.query": "[REDACTED]",
      "url.full": "https://[REDACTED]@auth.example.test/callback",
      nested: [
        {
          "http.url": "https://auth.example.test/token",
          "request.id": "request-123",
        },
      ],
    });
  });

  it("does not recurse forever through cyclic attributes", () => {
    const nested: Record<string, unknown> = {};
    nested.self = nested;
    nested["url.query"] = "ticket=secret";

    expect(scrubTraceAttributes({ nested })).toMatchObject({
      nested: {
        "url.query": "[REDACTED]",
      },
    });
  });

  it("strips malformed URL query text conservatively", () => {
    expect(scrubTraceUrl("/callback?code=secret#state=secret")).toBe("/callback");
  });
});
