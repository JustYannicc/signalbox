import { AuthSessionId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpEffect from "effect/http/HttpEffect";
import { HttpRouter } from "effect/http";

import * as UserDirectory from "../user/UserDirectory.ts";
import { makeMemoryCloud } from "../testing.ts";
import * as ClientTraceExport from "./ClientTraceExport.ts";
import * as ClientTraceLimits from "./ClientTraceLimits.ts";
import * as CloudSessions from "../auth/CloudSessions.ts";
import * as ClientTraceIntake from "./ClientTraceIntake.ts";
import * as Routes from "./clientTraceRoutes.ts";
import { filterTraces, type OtlpTraces } from "./nativeTracesFilter.ts";

const TRACE = "0123456789abcdef0123456789abcdef";
const SPAN = "0123456789abcdef";
const PERSON = "user_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const THREAD = "7b2dd8b5-cfee-49a1-86ce-bac041bf43b1";
const FOLDER = "8b9b5f11-587e-4ed0-a363-87f462deddd9";
const ORG = "org_01ARZ3NDEKTSV4RRFFQ69G5FAV";
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
                {
                  key: "folder.id",
                  value: { stringValue: "90f2a4bd-1178-4ebf-832f-642695d2a8e1" },
                },
                { key: "org.id", value: { stringValue: "org_01ARZ3NDEKTSV4RRFFQ69G5FAW" } },
                {
                  key: "url.full",
                  value: {
                    stringValue: `https://app.test/oauth?code=${CANARY}&state=${CANARY}&token=${CANARY}`,
                  },
                },
                { key: "thread.id", value: { stringValue: THREAD, intValue: CANARY } },
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
  const sent: Array<{ url: string; body: string; headers: Headers }> = [];
  const filtered: Array<OtlpTraces | null> = [];
  let requests = 0;
  const cloud = makeMemoryCloud();
  let upstreamStatus = 200;
  const authenticate: CloudSessions.CloudSessions["Service"]["authenticate"] = (credentials) =>
    credentials.bearer === "session" || credentials.cookie === "session"
      ? Effect.succeed({
          userId: PERSON,
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
      ClientTraceExport.layer({
        TRACE_EXPORT_TOKEN: "write-only-ingest-key",
        TRACE_EXPORT: {
          fetch: async (input) => {
            const request = new Request(input);
            const body = await request.text();
            sent.push({ url: request.url, body, headers: request.headers });
            filtered.push(
              filterTraces(JSON.parse(body), { stage: "pr-test", version: "test-release" }),
            );
            return new Response(null, { status: upstreamStatus });
          },
        },
      }),
    ),
    Layer.provide(ClientTraceLimits.layer({ limit: async () => ({ success: ++requests <= 300 }) })),
    Layer.provide(
      Layer.succeed(UserDirectory.UserDirectory, {
        ...cloud.userDirectory,
        forUser: (id) => ({
          ...cloud.userDirectory.forUser(id),
          clientTraceDimensions: (ids) =>
            Effect.succeed(
              ids.includes(THREAD) ? [{ threadId: THREAD, folderId: FOLDER, orgId: ORG }] : [],
            ),
        }),
      }),
    ),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: {
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
    filtered,
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
        const { post, sent, filtered } = yield* setup;
        expect((yield* post()).status).toBe(200);
        expect(sent).toHaveLength(1);
        expect(sent[0]?.url).toBe("https://trace-export/v1/traces");
        const exported = sent[0]?.body ?? "";
        expect(exported).not.toContain(CANARY);
        expect(exported).not.toContain("forged");
        expect(exported).not.toContain("90f2a4bd-1178-4ebf-832f-642695d2a8e1");
        expect(exported).not.toContain("org_01ARZ3NDEKTSV4RRFFQ69G5FAW");
        expect(exported).toContain(TRACE);
        expect(exported).toContain(SPAN);
        expect(exported).toContain("1111111111111111");
        expect(exported).toContain(PERSON);
        expect(exported).toContain(THREAD);
        expect(exported).toContain(FOLDER);
        expect(exported).toContain(ORG);
        expect(exported).toContain("pr-test");
        const spans = filtered[0]?.resourceSpans[0]?.scopeSpans[0]?.spans;
        expect(spans).toHaveLength(1);
        expect(spans?.[0]).toMatchObject({
          traceId: TRACE,
          spanId: SPAN,
          parentSpanId: "1111111111111111",
        });
        for (const dimension of [PERSON, THREAD, FOLDER, ORG]) {
          expect(JSON.stringify(filtered[0])).toContain(dimension);
        }
        expect(JSON.stringify(filtered[0])).not.toContain(CANARY);
        expect(sent[0]?.headers.get("authorization")).toBe("Bearer write-only-ingest-key");
        expect(sent[0]?.headers.get("x-sentry-auth")).toBeNull();
      }),
  );
  it.effect("omits thread dimensions the authenticated person cannot access", () =>
    Effect.gen(function* () {
      const { post, sent } = yield* setup;
      const document = payload();
      document.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.attributes = [
        { key: "thread.id", value: { stringValue: "90f2a4bd-1178-4ebf-832f-642695d2a8e1" } },
      ];
      expect((yield* post(JSON.stringify(document))).status).toBe(200);
      expect(sent[0]?.body).not.toContain("90f2a4bd-1178-4ebf-832f-642695d2a8e1");
      expect(sent[0]?.body).not.toContain('"folder.id"');
      expect(sent[0]?.body).not.toContain('"org.id"');
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
  it.effect("rejects too many spans and invalid trace identities without forwarding", () =>
    Effect.gen(function* () {
      const { post, sent } = yield* setup;
      const document = payload();
      const span = {
        ...document.resourceSpans[0]!.scopeSpans[0]!.spans[0]!,
        name: "client.operation",
        attributes: [],
        events: [],
        links: [],
        status: { code: 0, message: "" },
      };
      document.resourceSpans[0]!.scopeSpans[0]!.spans = Array.from({ length: 257 }, () => span);
      expect((yield* post(JSON.stringify(document))).status).toBe(400);
      document.resourceSpans[0]!.scopeSpans[0]!.spans = [{ ...span, traceId: "0".repeat(32) }];
      expect((yield* post(JSON.stringify(document))).status).toBe(400);
      document.resourceSpans[0]!.scopeSpans[0]!.spans = [{ ...span, endTimeUnixNano: "0" }];
      expect((yield* post(JSON.stringify(document))).status).toBe(400);
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
