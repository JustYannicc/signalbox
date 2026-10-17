// @effect-diagnostics cryptoRandomUUID:off - generated throwaway values, never vault credentials.
import { describe, expect, it } from "vite-plus/test";
import { serveEgress as serveProductionEgress } from "./egress.ts";
import { serveWithFakeNetwork as serveEgress } from "./egressTestKit.ts";
import { MAX_READ_BODY } from "./egressRequest.ts";

const value = `sk-throwaway-${crypto.randomUUID()}`;
const authoritySecret = `sk-${crypto.randomUUID()}`;
const registration = (value: string, revision = 1) => ({
  registered: 1,
  registeredRunId: "test-run",
  revision,
  current: [{ name: "KEY", value }],
  values: [{ name: "KEY", value }],
});
const fixtures = [
  {
    kind: "binary",
    headers: { "content-type": "application/octet-stream" },
    body: new TextEncoder().encode(value),
  },
  {
    kind: "oversized",
    headers: { "content-type": "text/plain" },
    body: "x".repeat(MAX_READ_BODY + 1) + value,
  },
  {
    kind: "compressed",
    headers: { "content-type": "text/plain", "content-encoding": "gzip" },
    body: value,
  },
  {
    kind: "invalid UTF-8",
    headers: { "content-type": "text/plain" },
    body: new Uint8Array([255, ...new TextEncoder().encode(value)]),
  },
];

describe("egress security boundary", () => {
  it.each([
    ["raw", authoritySecret],
    [
      "base64url encoded",
      btoa(authoritySecret).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""),
    ],
  ])("refuses a %s secret in the destination before asking or sending", async (_kind, host) => {
    let approvals = 0;
    let sends = 0;
    const response = await serveEgress(
      new Request(`https://${host}.untrusted.example:8443/upload`),
      {
        ownHosts: new Set(),
        thread: {
          secrets: async () => registration(authoritySecret),
          authorize: async () => {
            approvals++;
            return { _tag: "allowed" };
          },
        },
        send: async () => {
          sends++;
          return new Response("ok");
        },
      },
    );

    expect(response.status).toBe(403);
    expect(approvals).toBe(0);
    expect(sends).toBe(0);
    const refusal = await response.text();
    expect(refusal).not.toContain(authoritySecret);
    expect(refusal).not.toContain(host);
  });

  it("refuses a secret in URL userinfo before asking or sending", async () => {
    let approvals = 0;
    let sends = 0;
    // Fetch normally rejects userinfo URLs; keep the egress boundary defensive if one arrives.
    const request = {
      url: `https://${authoritySecret}@untrusted.example:8443/upload`,
      method: "GET",
      headers: new Headers(),
      body: null,
    } as Request;
    const response = await serveEgress(request, {
      ownHosts: new Set(),
      thread: {
        secrets: async () => registration(authoritySecret),
        authorize: async () => {
          approvals++;
          return { _tag: "allowed" };
        },
      },
      send: async () => {
        sends++;
        return new Response("ok");
      },
    });

    expect(response.status).toBe(403);
    expect(approvals).toBe(0);
    expect(sends).toBe(0);
    expect((await response.text()).includes(authoritySecret)).toBe(false);
  });

  it.each(fixtures)("never forwards a $kind body over HTTP or HTTPS", async ({ headers, body }) => {
    const sent: Array<Request> = [];
    for (const protocol of ["http", "https"]) {
      const response = await serveEgress(
        new Request(`${protocol}://untrusted.example/upload`, { method: "POST", headers, body }),
        {
          ownHosts: new Set(),
          thread: {
            secrets: async () => registration(value),
            authorize: async () => ({ _tag: "allowed" }),
          },
          send: async (request) => {
            sent.push(request);
            return new Response("ok");
          },
        },
      );
      expect(response.status).toBe(403);
    }
    expect(sent).toHaveLength(0);
  });

  it("refuses a body-only secret without approval, and always refuses it over HTTP", async () => {
    for (const protocol of ["http", "https"]) {
      let sends = 0;
      let approvals = 0;
      const response = await serveEgress(
        new Request(`${protocol}://untrusted.example/`, { method: "POST", body: "{{secret:KEY}}" }),
        {
          ownHosts: new Set(),
          thread: {
            secrets: async () => registration(value),
            authorize: async () => {
              approvals++;
              return { _tag: "refused", message: "no" };
            },
          },
          send: async () => {
            sends++;
            return new Response("ok");
          },
        },
      );
      expect(response.status).toBe(403);
      expect(approvals).toBe(protocol === "https" ? 1 : 0);
      expect(sends).toBe(0);
    }
  });

  it("scrubs echoed values from response headers and bodies before a program can persist them", async () => {
    const response = await serveEgress(
      new Request("https://approved.example/", {
        headers: { authorization: "Bearer {{secret:KEY}}" },
      }),
      {
        ownHosts: new Set(),
        thread: {
          secrets: async () => registration(value),
          authorize: async () => ({ _tag: "allowed" }),
        },
        send: async (request) =>
          new Response(JSON.stringify({ authorization: request.headers.get("authorization") }), {
            headers: { "x-echo": value, "content-type": "application/json" },
          }),
      },
    );
    expect(response.headers.get("x-echo")).toBe("{{secret:KEY}}");
    expect(await response.text()).toBe(JSON.stringify({ authorization: "Bearer {{secret:KEY}}" }));
  });

  it("scrubs stored secret values echoed by a request that carried no secret", async () => {
    const response = await serveEgress(new Request("https://approved.example/health"), {
      ownHosts: new Set(),
      thread: {
        secrets: async () => registration(value),
        authorize: async () => ({ _tag: "allowed" }),
      },
      send: async () =>
        new Response(value, { headers: { "content-type": "text/plain; charset=utf-8" } }),
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("{{secret:KEY}}");
  });

  it("scrubs known values from compressed text responses to secret-free requests", async () => {
    const body = new Blob([value]).stream().pipeThrough(new CompressionStream("gzip"));
    const response = await serveEgress(new Request("https://approved.example/health"), {
      ownHosts: new Set(),
      thread: {
        secrets: async () => registration(value),
        authorize: async () => ({ _tag: "allowed" }),
      },
      send: async () =>
        new Response(body, {
          headers: {
            "content-encoding": "gzip",
            "content-type": "text/plain; charset=utf-8",
          },
        }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(await response.text()).toBe("{{secret:KEY}}");
  });

  it("stops a binary response on a matching value before any secret byte returns", async () => {
    const response = await serveEgress(new Request("https://approved.example/archive"), {
      ownHosts: new Set(),
      thread: {
        secrets: async () => registration(value),
        authorize: async () => ({ _tag: "allowed" }),
      },
      send: async () =>
        new Response(new TextEncoder().encode(value), {
          headers: { "content-type": "application/octet-stream" },
        }),
    });

    const received: Array<Uint8Array> = [];
    let failure: unknown;
    try {
      for await (const chunk of response.body!) received.push(chunk);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain("KEY");
    expect(String(failure)).not.toContain(value);
    expect(
      new TextDecoder().decode(Uint8Array.from(received.flatMap((chunk) => [...chunk]))),
    ).not.toContain(value);
  });

  it("does not fetch a second secret snapshot before production dispatch", async () => {
    let secretReads = 0;
    let dispatches = 0;
    const response = await serveProductionEgress(new Request("https://approved.example/health"), {
      ownHosts: new Set(),
      thread: {
        secrets: async () => {
          secretReads++;
          return registration(value);
        },
        authorize: async () => ({ _tag: "refused", message: "unexpected approval" }),
      },
      dispatch: async () => {
        dispatches++;
        return { _tag: "sent", response: new Response("ok") };
      },
    });

    expect(response.status).toBe(200);
    expect(secretReads).toBe(1);
    expect(dispatches).toBe(1);
  });

  it("still checks retired values against approval and HTTPS", async () => {
    const current = `sk-current-${crypto.randomUUID()}`;
    let sends = 0;
    let approvals = 0;
    const response = await serveEgress(
      new Request("http://untrusted.example/", { method: "POST", body: value }),
      {
        ownHosts: new Set(),
        thread: {
          secrets: async () => ({
            ...registration(current),
            values: [
              { name: "KEY", value },
              { name: "KEY", value: current },
            ],
          }),
          authorize: async () => {
            approvals++;
            return { _tag: "allowed" };
          },
        },
        send: async () => {
          sends++;
          return new Response("ok");
        },
      },
    );
    expect(response.status).toBe(403);
    expect(approvals).toBe(0);
    expect(sends).toBe(0);
  });

  it("rechecks an apparently secret-free body when registration changes during inspection", async () => {
    const next = `sk-next-${crypto.randomUUID()}`;
    let reads = 0;
    let sends = 0;
    let approvals = 0;
    const response = await serveEgress(
      new Request("https://untrusted.example/", { method: "POST", body: next }),
      {
        ownHosts: new Set(),
        thread: {
          secrets: async () => (++reads === 1 ? registration(value, 1) : registration(next, 2)),
          authorize: async () => {
            approvals++;
            return { _tag: "refused", message: "no" };
          },
        },
        send: async () => {
          sends++;
          return new Response("ok");
        },
      },
    );
    expect(response.status).toBe(403);
    expect(approvals).toBe(1);
    expect(sends).toBe(0);
  });

  it("refuses a value the shared scrubber cannot redact", async () => {
    let sends = 0;
    const response = await serveEgress(
      new Request("https://approved.example/", { headers: { "x-key": "{{secret:KEY}}" } }),
      {
        ownHosts: new Set(),
        thread: {
          secrets: async () => registration("tiny"),
          authorize: async () => ({ _tag: "allowed" }),
        },
        send: async () => {
          sends++;
          return new Response("tiny");
        },
      },
    );
    expect(response.status).toBe(403);
    expect(sends).toBe(0);
  });

  it("does not expose a resolved URL when the outbound client throws", async () => {
    const response = await serveEgress(
      new Request("https://approved.example/?key={{secret:KEY}}"),
      {
        ownHosts: new Set(),
        thread: {
          secrets: async () => registration(value),
          authorize: async () => ({ _tag: "allowed" }),
        },
        send: async (outgoing) => {
          throw new Error(`failed ${outgoing.url}`);
        },
      },
    );
    expect(response.status).toBe(403);
    expect((await response.text()).includes(value)).toBe(false);
  });

  it("refreshes the value after approval instead of sending a cached pre-rotation value", async () => {
    const next = `sk-rotated-${crypto.randomUUID()}`;
    let current = value;
    let revision = 1;
    let sent = "";
    await serveEgress(
      new Request("https://approved.example/", { headers: { "x-key": "{{secret:KEY}}" } }),
      {
        ownHosts: new Set(),
        thread: {
          secrets: async () => registration(current, revision),
          authorize: async () => {
            if (current !== next) revision++;
            current = next;
            return { _tag: "allowed" };
          },
        },
        send: async (request) => {
          sent = request.headers.get("x-key") ?? "";
          return new Response("ok");
        },
      },
    );
    expect(sent === next).toBe(true);
  });
});
