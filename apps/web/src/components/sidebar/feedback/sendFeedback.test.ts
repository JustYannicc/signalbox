import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../../account/accountSession", () => ({
  readAccountSession: () => ({
    enabled: true,
    providers: [],
    account: { id: "user_123", email: "ada@example.com", firstName: "Ada", lastName: "Lovelace" },
  }),
}));

const DSN = "https://public@o1.ingest.sentry.io/42";

async function loadSendFeedback() {
  vi.stubEnv("VITE_T3CODE_FEEDBACK_DSN", DSN);
  return import("./sendFeedback");
}

// The SDK posts one envelope: newline-separated JSON headers and payloads.
function envelopeText(body: unknown): string {
  return typeof body === "string" ? body : new TextDecoder().decode(body as Uint8Array);
}

describe("sendFeedback", () => {
  let posted: Array<{ url: string; body: string }>;
  let status: number;

  beforeEach(() => {
    posted = [];
    status = 200;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        posted.push({ url, body: envelopeText(init.body) });
        return new Response("", { status });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("sends the message, tags, user and both attachments to the DSN's project", async () => {
    const { sendFeedback } = await loadSendFeedback();

    await sendFeedback({
      message: "The rail button works",
      screenshot: new Blob(["png-bytes"], { type: "image/png" }),
      serverLogs: "2026-10-05T10:00:00.000Z [Error] ws.request: boom",
    });

    expect(posted).toHaveLength(1);
    const [request] = posted;
    expect(request!.url).toContain("o1.ingest.sentry.io/api/42/envelope/");
    const lines = request!.body.split("\n");
    const feedback = JSON.parse(lines[lines.indexOf('{"type":"feedback"}') + 1]!);
    expect(feedback.contexts.feedback).toMatchObject({
      message: "The rail button works",
      contact_email: "ada@example.com",
      name: "Ada Lovelace",
      source: "sidebar-rail",
    });
    expect(feedback.tags).toMatchObject({ channel: "dev", surface: "web" });
    expect(feedback.user).toMatchObject({ id: "user_123", email: "ada@example.com" });
    expect(feedback.release).toMatch(/^signalbox@/);
    expect(request!.body).toContain('"filename":"screenshot.png"');
    expect(request!.body).toContain("png-bytes");
    expect(request!.body).toContain('"filename":"server-logs.txt"');
    expect(request!.body).toContain("ws.request: boom");
  });

  it("rejects when Sentry refuses the envelope, so the draft is kept", async () => {
    const { sendFeedback } = await loadSendFeedback();
    status = 403;

    await expect(
      sendFeedback({ message: "Rejected", screenshot: null, serverLogs: null }),
    ).rejects.toThrow("Sentry rejected the feedback.");
  });
});
