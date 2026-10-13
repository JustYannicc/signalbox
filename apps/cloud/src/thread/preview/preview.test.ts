import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { requestHeaders, responseHeaders } from "./previewHeaders.ts";
import { labelOfHost, previewLabel, previewSettings, withoutCookie } from "./previewHost.ts";
import { previewToken, threadOfPreviewToken, verifyPreviewToken } from "./previewToken.ts";

const threadId = ThreadId.make("thread:4f1c");
const claims = { k: "session", t: threadId, u: "user_1", p: 5173, exp: 10_000 } as const;

describe("preview tokens", () => {
  it("verify only with the lease token that signed them, until they expire", async () => {
    const token = await previewToken("lease-a", claims);
    expect(threadOfPreviewToken(token)).toBe(threadId);
    expect(await verifyPreviewToken(token, "lease-a", 9_999)).toEqual(claims);
    // The next machine generation has another lease token.
    expect(await verifyPreviewToken(token, "lease-b", 9_999)).toBeNull();
    expect(await verifyPreviewToken(token, "lease-a", 10_000)).toBeNull();
  });

  it("reject edited claims", async () => {
    const token = await previewToken("lease-a", claims);
    const [prefix, , signature] = token.split(".");
    const forged = await previewToken("lease-a", { ...claims, p: 22 });
    const forgedPayload = forged.split(".")[1];
    expect(
      await verifyPreviewToken(`${prefix}.${forgedPayload}.${signature}`, "lease-a", 0),
    ).toBeNull();
    expect(threadOfPreviewToken("sbm1.abc.def")).toBeNull();
  });
});

describe("preview hosts", () => {
  it("give each thread and port a stable DNS label of their own", async () => {
    const label = await previewLabel(threadId, 5173);
    expect(label).toMatch(/^[a-z2-7]{26}$/);
    expect(await previewLabel(threadId, 5173)).toBe(label);
    expect(await previewLabel(threadId, 3000)).not.toBe(label);
    const settings = previewSettings({ PREVIEW_DOMAIN: "localhost:8787", LOCAL_WORKERD: "1" });
    expect(settings).toEqual({ domain: "localhost:8787", hostname: "localhost", scheme: "http" });
    expect(labelOfHost(settings!, `${label}.localhost`)).toBe(label);
    expect(labelOfHost(settings!, "localhost")).toBeNull();
    expect(labelOfHost(settings!, "app.localhost")).toBeNull();
    expect(previewSettings({})).toBeNull();
  });
});

describe("preview headers", () => {
  const origin = "https://abc.preview.example";

  it("send the dev server a plain localhost request without the gateway's cookie", () => {
    const headers = requestHeaders(
      new Headers({
        host: "abc.preview.example",
        cookie: "theme=dark; signalbox_preview=secret; sid=1",
        origin,
        referer: `${origin}/src/main.ts`,
        "cf-connecting-ip": "203.0.113.9",
        connection: "upgrade",
        "sec-websocket-key": "k",
        accept: "text/html",
      }),
      { origin, port: 5173 },
    );
    expect(Object.fromEntries(headers)).toEqual({
      host: "localhost:5173",
      cookie: "theme=dark; sid=1",
      origin: "http://localhost:5173",
      referer: "http://localhost:5173/src/main.ts",
      accept: "text/html",
    });
    expect(withoutCookie("signalbox_preview=x", "signalbox_preview")).toBeNull();
  });

  it("keep redirects on the preview origin and the gateway's cookie the gateway's", () => {
    const headers = responseHeaders(
      [
        ["Location", "http://localhost:5173/login?next=%2F"],
        ["Set-Cookie", "signalbox_preview=evil; Path=/"],
        ["Set-Cookie", "sid=2; Path=/"],
        ["Content-Length", "12"],
        ["Transfer-Encoding", "chunked"],
        ["Content-Type", "text/html"],
      ],
      { port: 5173 },
    );
    expect(headers.get("location")).toBe("/login?next=%2F");
    expect(headers.getSetCookie()).toEqual(["sid=2; Path=/"]);
    expect(headers.get("content-length")).toBeNull();
    expect(headers.get("transfer-encoding")).toBeNull();
    expect(headers.get("content-type")).toBe("text/html");
    expect(
      responseHeaders([["location", "https://example.com/x"]], { port: 5173 }).get("location"),
    ).toBe("https://example.com/x");
  });
});
