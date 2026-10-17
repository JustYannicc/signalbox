// @effect-diagnostics cryptoRandomUUID:off - generated throwaway values, never vault credentials.
import { describe, expect, it } from "vite-plus/test";
import { serveWithFakeNetwork as serveEgress } from "./egressTestKit.ts";
import { MAX_READ_BODY } from "./egressRequest.ts";

const value = `sk-throwaway-${crypto.randomUUID()}`;
const registration = (value: string, revision = 1) => ({
  registered: 1,
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
