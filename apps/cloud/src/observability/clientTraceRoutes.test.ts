import { AuthSessionId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpEffect from "effect/http/HttpEffect";
import { FetchHttpClient, HttpRouter } from "effect/http";

import * as CloudSessions from "../auth/CloudSessions.ts";
import * as ClientTraceIntake from "./ClientTraceIntake.ts";
import * as Routes from "./clientTraceRoutes.ts";

const TRACE = "0123456789abcdef0123456789abcdef";
const SPAN = "0123456789abcdef";
const CANARY = "message and file content must never leave intake";
const payload = () => ({
  resourceSpans: [
    {
      resource: { attributes: [{ key: "service.name", value: { stringValue: CANARY } }] },
      scopeSpans: [
        {
          scope: { name: CANARY },
          spans: [
            {
              name: CANARY,
              traceId: TRACE,
              spanId: SPAN,
              parentSpanId: "1111111111111111",
              startTimeUnixNano: "1000000000",
              endTimeUnixNano: "2000000000",
              attributes: [
                { key: "message", value: { stringValue: CANARY } },
                { key: "person.id", value: { stringValue: "forged" } },
                { key: "thread.id", value: { stringValue: "thread_test", intValue: CANARY } },
              ],
              events: [{ name: CANARY }],
              links: [{ attributes: [{ key: "file", value: { stringValue: CANARY } }] }],
              status: { code: 2, message: CANARY },
            },
          ],
        },
      ],
    },
  ],
});

const setup = Effect.gen(function* () {
  const sent: Array<{ url: string; init: RequestInit | undefined }> = [];
  let upstreamStatus = 200;
  const authenticate: CloudSessions.CloudSessions["Service"]["authenticate"] = (credentials) =>
    credentials.bearer === "session" || credentials.cookie === "session"
      ? Effect.succeed({
          userId: "user_test",
          sessionId: AuthSessionId.make("session_test"),
          method: "bearer-access-token",
          scopes: [],
          expiresAt: Number.MAX_SAFE_INTEGER,
        })
      : Effect.fail(new CloudSessions.CloudCredentialError({ reason: "invalid_credential" }));
  const services = ClientTraceIntake.layer.pipe(
    Layer.provide(
      Layer.succeed(
        CloudSessions.CloudSessions,
        CloudSessions.CloudSessions.of({
          authenticate,
          claims: () => Effect.die("unused"),
          ticketClaims: () => Effect.die("unused"),
          create: () => Effect.die("unused"),
          exchangeCredential: () => Effect.die("unused"),
          signCredential: () => Effect.die("unused"),
          issueTicket: () => Effect.die("unused"),
          revoke: () => Effect.die("unused"),
        }),
      ),
    ),
    Layer.provide(
      FetchHttpClient.layer.pipe(
        Layer.provide(
          Layer.succeed(FetchHttpClient.Fetch, async (url, init) => {
            sent.push({ url: String(url), init });
            return new Response(null, { status: upstreamStatus });
          }),
        ),
      ),
    ),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: {
            SENTRY_DSN: "https://public@o123.ingest.de.sentry.io/456",
            SIGNALBOX_STAGE: "pr-test",
            APP_VERSION: "test-release",
          },
        }),
      ),
    ),
  );
  const context = yield* Layer.build(services);
  const router = yield* HttpRouter.toHttpEffect(Routes.layer);
  const handler = HttpEffect.toWebHandler(router.pipe(Effect.provide(context)));
  const post = (body = JSON.stringify(payload()), headers: Record<string, string> = {}) =>
    Effect.promise(() =>
      handler(
        new Request("https://app.test/api/observability/v1/traces", {
          method: "POST",
          body,
          headers: {
            "content-type": "application/json",
            authorization: "Bearer session",
            ...headers,
          },
        }),
      ),
    );
  return {
    post,
    sent,
    setUpstreamStatus: (status: number) => {
      upstreamStatus = status;
    },
  };
});

describe("Cloud browser trace intake", () => {
  it.effect(
    "serves the real browser path and preserves trace joins while stripping all content",
    () =>
      Effect.gen(function* () {
        const { post, sent } = yield* setup;
        expect((yield* post()).status).toBe(200);
        expect(sent).toHaveLength(1);
        expect(sent[0]?.url).toBe(
          "https://o123.ingest.de.sentry.io/api/456/integration/otlp/v1/traces",
        );
        const exported = new TextDecoder().decode(sent[0]?.init?.body as Uint8Array);
        expect(exported).not.toContain(CANARY);
        expect(exported).not.toContain("forged");
        expect(exported).toContain(TRACE);
        expect(exported).toContain(SPAN);
        expect(exported).toContain("1111111111111111");
        expect(exported).toContain("user_test");
        expect(exported).toContain("pr-test");
        expect(new Headers(sent[0]?.init?.headers).get("x-sentry-auth")).toBe(
          "sentry sentry_key=public",
        );
        expect(new Headers(sent[0]?.init?.headers).get("authorization")).toBeNull();
      }),
  );
  it.effect("requires a live cookie or bearer session before reading or forwarding", () =>
    Effect.gen(function* () {
      const { post, sent } = yield* setup;
      expect((yield* post("invalid", { authorization: "" })).status).toBe(401);
      expect(sent).toHaveLength(0);
      expect(
        (yield* post(undefined, { authorization: "", cookie: "signalbox_cloud_session=session" }))
          .status,
      ).toBe(200);
    }),
  );
  it.effect("rejects malformed, oversized and unsupported bodies without forwarding", () =>
    Effect.gen(function* () {
      const { post, sent } = yield* setup;
      expect((yield* post("not json")).status).toBe(400);
      expect((yield* post("x".repeat(128 * 1024 + 1))).status).toBe(413);
      expect((yield* post(undefined, { "content-length": "131073" })).status).toBe(413);
      expect((yield* post(undefined, { "content-type": "application/x-protobuf" })).status).toBe(
        415,
      );
      expect((yield* post(undefined, { "content-encoding": "gzip" })).status).toBe(415);
      expect(sent).toHaveLength(0);
    }),
  );
  it.effect("rate limits an authenticated person across cookie and bearer sessions", () =>
    Effect.gen(function* () {
      const { post, sent } = yield* setup;
      for (let i = 0; i < 300; i++) expect((yield* post()).status).toBe(200);
      expect(
        (yield* post(undefined, { authorization: "", cookie: "signalbox_cloud_session=session" }))
          .status,
      ).toBe(429);
      expect(sent).toHaveLength(300);
    }),
  );
  it.effect("does not claim delivery when Sentry rejects the batch", () =>
    Effect.gen(function* () {
      const { post, setUpstreamStatus } = yield* setup;
      setUpstreamStatus(503);
      expect((yield* post()).status).toBe(502);
    }),
  );
});
