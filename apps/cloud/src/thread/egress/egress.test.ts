// @effect-diagnostics cryptoRandomUUID:off - fake secrets are generated per run, so no test ever holds a real one.
import { describe, expect, it } from "vite-plus/test";

import { REFUSED_HEADER } from "./egress.ts";
import { serveWithFakeNetwork as serveEgress } from "./egressTestKit.ts";
import { MAX_READ_BODY } from "./egressRequest.ts";
import type { SendAnswer } from "./ThreadSends.ts";

const KEY = `sk-test-${crypto.randomUUID()}`;
const TOKEN = `ghp-test-${crypto.randomUUID()}`;
const secrets = [
  { name: "KEY", value: KEY },
  { name: "TOKEN", value: TOKEN },
];

/** A thread answering every send with `answer`, and the requests that went out. */
const harness = (answer: SendAnswer = { _tag: "allowed" }) => {
  const asked: Array<{ host: string; names: ReadonlyArray<string> }> = [];
  const sent: Array<Request> = [];
  const serve = (request: Request, own: ReadonlyArray<string> = ["app.signalbox.run"]) =>
    serveEgress(request, {
      thread: {
        secrets: async () => ({
          current: secrets,
          values: secrets,
          registered: 1,
          registeredRunId: "test-run",
          revision: 1,
        }),
        authorize: async ({ host, names }) => {
          asked.push({ host, names });
          return answer;
        },
      },
      ownHosts: new Set(own),
      send: async (outgoing) => {
        sent.push(outgoing);
        return new Response("ok");
      },
    });
  return { serve, asked, sent };
};

describe("egress", () => {
  it.each(["1", "abc", "abcdefg"])(
    "fills an approved short placeholder and redacts its text echo: %s",
    async (value) => {
      const current = [{ name: "SHORT_KEY", value }];
      const asked: Array<ReadonlyArray<string>> = [];
      let sentValue: string | null = null;
      const response = await serveEgress(
        new Request("https://api.example.test/", {
          headers: { "x-secret": "{{secret:SHORT_KEY}}" },
        }),
        {
          ownHosts: new Set(),
          thread: {
            secrets: async () => ({
              registered: 1,
              registeredRunId: "short-echo",
              revision: 1,
              current,
              values: current,
            }),
            authorize: async ({ names }) => {
              asked.push(names);
              return { _tag: "allowed" };
            },
          },
          send: async (outgoing) => {
            sentValue = outgoing.headers.get("x-secret");
            return new Response(value, { headers: { "content-type": "text/plain" } });
          },
        },
      );
      expect(response.status).toBe(200);
      expect(asked).toEqual([["SHORT_KEY"]]);
      expect(sentValue).toBe(value);
      expect(await response.text()).toBe("{{secret:SHORT_KEY}}");
    },
  );

  it("fills placeholders in the URL, headers, a Basic credential and a text body", async () => {
    const { serve, asked, sent } = harness();

    const response = await serve(
      new Request("https://api.example.test/v1?key=%7B%7Bsecret:KEY%7D%7D", {
        method: "POST",
        headers: {
          authorization: `Basic ${btoa("me:{{secret:TOKEN}}")}`,
          "x-api-key": "{{ secret:KEY }}",
          "content-type": "application/json",
        },
        body: JSON.stringify({ token: "{{secret:TOKEN}}" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(asked).toEqual([{ host: "api.example.test", names: ["KEY", "TOKEN"] }]);
    const [out] = sent;
    expect(out!.url).toBe(`https://api.example.test/v1?key=${encodeURIComponent(KEY)}`);
    expect(out!.headers.get("x-api-key")).toBe(KEY);
    expect(out!.headers.get("authorization")).toBe(`Basic ${btoa(`me:${TOKEN}`)}`);
    expect(await out!.json()).toEqual({ token: TOKEN });
  });

  it("checks a value a program read from a file the same as a placeholder", async () => {
    const { serve, asked, sent } = harness();

    await serve(
      new Request("https://hooks.example.test/in", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: `KEY=${KEY}\n`,
      }),
    );

    expect(asked).toEqual([{ host: "hooks.example.test", names: ["KEY"] }]);
    expect(await sent[0]!.text()).toBe(`KEY=${KEY}\n`);
  });

  it("refuses what the person didn't allow, and a name the thread has no secret for, sending nothing", async () => {
    const waiting = harness({ _tag: "waiting", message: "Waiting for the person." });
    const refused = await waiting.serve(
      new Request("https://evil.example.test/", { headers: { "x-k": "{{secret:KEY}}" } }),
    );
    expect(refused.status).toBe(403);
    expect(refused.headers.get(REFUSED_HEADER)).toBe("secret");
    expect(await refused.text()).toContain("Waiting for the person.");
    expect(waiting.sent).toEqual([]);

    const unknown = harness();
    const response = await unknown.serve(
      new Request("https://api.example.test/", { headers: { "x-k": "{{secret:NOPE}}" } }),
    );
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("no secret called NOPE");
    expect(unknown.asked).toEqual([]);
    expect(unknown.sent).toEqual([]);
  });

  it("fills a form body's encoded placeholders, and never sends a secret over plain HTTP", async () => {
    const { serve, sent } = harness();

    await serve(
      new Request("https://api.example.test/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ key: "{{secret:KEY}}" }),
      }),
    );
    expect(new URLSearchParams(await sent[0]!.text()).get("key")).toBe(KEY);

    const plain = await serve(
      new Request("http://api.example.test/", { headers: { "x-k": "{{secret:KEY}}" } }),
    );
    expect(plain.status).toBe(403);
    expect(await plain.text()).toContain("over plain HTTP");
    expect(sent).toHaveLength(1);
  });

  it("inspects Git fetch negotiation without changing its packet bytes", async () => {
    const { serve, asked, sent } = harness();
    const body = "0014command=ls-refs\n0015agent=git/2.50.1\n00010009peel\n000csymrefs\n0000";
    const response = await serve(
      new Request("https://git.example.test/project.git/git-upload-pack", {
        method: "POST",
        headers: {
          "content-type": "application/x-git-upload-pack-request",
          "git-protocol": "version=2",
        },
        body,
      }),
    );

    expect(response.status).toBe(200);
    expect(asked).toEqual([]);
    expect(await sent[0]!.text()).toBe(body);
    expect(sent[0]!.headers.get("content-type")).toBe("application/x-git-upload-pack-request");
  });

  it("keeps Git negotiation subject to secret approval, HTTPS and bounded UTF-8 inspection", async () => {
    const { serve, asked, sent } = harness({ _tag: "refused", message: "not approved" });
    for (const protocol of ["http", "https"]) {
      const response = await serve(
        new Request(`${protocol}://git.example.test/project.git/git-upload-pack`, {
          method: "POST",
          headers: { "content-type": "application/x-git-upload-pack-request" },
          body: `want ${KEY}\n`,
        }),
      );
      expect(response.status).toBe(403);
    }
    const binary = await serve(
      new Request("https://git.example.test/project.git/git-upload-pack", {
        method: "POST",
        headers: { "content-type": "application/x-git-upload-pack-request" },
        body: new Uint8Array([0xff, ...new TextEncoder().encode(KEY)]),
      }),
    );
    expect(binary.status).toBe(403);
    expect(asked).toEqual([{ host: "git.example.test", names: ["KEY"] }]);
    expect(sent).toEqual([]);
  });

  it("inspects compressed Git negotiation and preserves its original bytes", async () => {
    const compress = async (text: string, format: "gzip" | "deflate") =>
      new Uint8Array(
        await new Response(
          new Blob([text]).stream().pipeThrough(new CompressionStream(format)),
        ).arrayBuffer(),
      );
    for (const format of ["gzip", "deflate"] as const) {
      const { serve, asked, sent } = harness();
      const packed = await compress("0014command=ls-refs\n0000", format);
      const response = await serve(
        new Request("https://git.example.test/project.git/git-upload-pack", {
          method: "POST",
          headers: {
            "content-type": "application/x-git-upload-pack-request",
            "content-encoding": format,
          },
          body: packed,
        }),
      );
      expect(response.status).toBe(200);
      expect(asked).toEqual([]);
      expect(new Uint8Array(await sent[0]!.arrayBuffer())).toEqual(packed);
      expect(sent[0]!.headers.get("content-encoding")).toBe(format);

      const denied = harness({ _tag: "refused", message: "not approved" });
      const secret = await denied.serve(
        new Request("https://git.example.test/project.git/git-upload-pack", {
          method: "POST",
          headers: {
            "content-type": "application/x-git-upload-pack-request",
            "content-encoding": format,
          },
          body: await compress(`want ${KEY}\n`, format),
        }),
      );
      expect(secret.status).toBe(403);
      expect(denied.asked).toEqual([{ host: "git.example.test", names: ["KEY"] }]);
      expect(denied.sent).toEqual([]);
    }

    const filled = harness();
    const substituted = await filled.serve(
      new Request("https://git.example.test/project.git/git-upload-pack", {
        method: "POST",
        headers: {
          "content-type": "application/x-git-upload-pack-request",
          "content-encoding": "gzip",
        },
        body: await compress("{{secret:KEY}}", "gzip"),
      }),
    );
    expect(substituted.status).toBe(200);
    expect(await filled.sent[0]!.text()).toBe(KEY);
    expect(filled.sent[0]!.headers.get("content-encoding")).toBeNull();
    expect(filled.sent[0]!.headers.get("content-length")).toBeNull();

    const { serve, sent } = harness();
    const tooLarge = await serve(
      new Request("https://git.example.test/project.git/git-upload-pack", {
        method: "POST",
        headers: {
          "content-type": "application/x-git-upload-pack-request",
          "content-encoding": "gzip",
        },
        body: await compress("x".repeat(MAX_READ_BODY + 1), "gzip"),
      }),
    );
    expect(tooLarge.status).toBe(403);
    expect(sent).toEqual([]);
  });

  it("refuses an unknown-length body that exceeds the inspection limit", async () => {
    const { serve, asked, sent } = harness();
    const big = "x".repeat(MAX_READ_BODY + 10);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        // No length, in pieces, as a chunked upload arrives.
        const bytes = new TextEncoder().encode(big);
        for (let at = 0; at < bytes.length; at += 64 * 1024) {
          controller.enqueue(bytes.slice(at, at + 64 * 1024));
        }
        controller.close();
      },
    });

    const response = await serve(
      new Request("https://upload.example.test/", {
        method: "PUT",
        headers: { "content-type": "text/plain" },
        body,
        duplex: "half",
      } as RequestInit),
    );

    expect(asked).toEqual([]);
    expect(response.status).toBe(403);
    expect(sent).toEqual([]);
  });

  it("lets requests without secrets, and Signalbox's own, through untouched", async () => {
    const { serve, asked, sent } = harness({ _tag: "refused", message: "no" });

    await serve(new Request("https://registry.npmjs.org/effect"));
    await serve(
      new Request("https://app.signalbox.run/api/runner/sessions/append", {
        method: "POST",
        body: `{"text":"{{secret:KEY}}"}`,
      }),
    );

    expect(asked).toEqual([]);
    expect(sent.map((request) => request.url)).toEqual([
      "https://registry.npmjs.org/effect",
      "https://app.signalbox.run/api/runner/sessions/append",
    ]);
    // Signalbox's own requests keep their placeholders: the model reads them.
    expect(await sent[1]!.text()).toBe(`{"text":"{{secret:KEY}}"}`);
  });
});
