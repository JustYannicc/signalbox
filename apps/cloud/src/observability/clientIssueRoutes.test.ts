import { AuthSessionId, WsRpcGroup } from "@t3tools/contracts";
import { CLIENT_ISSUES_PATH } from "@t3tools/contracts/clientIssues";
import { describe, expect, it } from "@effect/vitest";
import { initLogger, type WideEvent } from "evlog";
import { toSentryErrorEvent, toSentryLog } from "evlog/sentry";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as HttpEffect from "effect/http/HttpEffect";
import { HttpRouter } from "effect/http";

import * as CloudSessions from "../auth/CloudSessions.ts";
import { makeMemoryCloud } from "../testing.ts";
import * as UserDirectory from "../user/UserDirectory.ts";
import * as ClientTraceExport from "./ClientTraceExport.ts";
import * as ClientTraceLimits from "./ClientTraceLimits.ts";
import * as ClientIssueIntake from "./ClientIssueIntake.ts";
import * as Routes from "./clientIssueRoutes.ts";
import * as Evlog from "./Evlog.ts";
import { filterTraces, type OtlpTraces } from "./nativeTracesFilter.ts";

const TRACE = "0123456789abcdef0123456789abcdef";
const OTHER_TRACE = "fedcba9876543210fedcba9876543210";
const SPAN = "0123456789abcdef";
const OTHER_SPAN = "fedcba9876543210";
const METHOD = [...WsRpcGroup.requests.keys()][0]!;
const PERSON = "user_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const THREAD = "7b2dd8b5-cfee-49a1-86ce-bac041bf43b1";
const FOLDER = "8b9b5f11-587e-4ed0-a363-87f462deddd9";
const FORGED_FOLDER = "90f2a4bd-1178-4ebf-832f-642695d2a8e1";
const CANARY = "canary-private-message-stack-token";
const payload = (overrides: Record<string, unknown> = {}) => ({
  code: "rpc.failed",
  severity: "error",
  source: "rpc",
  client: "web",
  release: "1.2.3",
  threadId: THREAD,
  folderId: FORGED_FOLDER,
  environmentId: "claimed-environment",
  traceId: TRACE,
  spanId: SPAN,
  method: METHOD,
  durationMs: 25,
  ...overrides,
});

const setup = (
  options: {
    readonly authorized?: boolean;
    readonly limited?: boolean;
    readonly telemetry?: string;
    readonly failExport?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const events: Array<WideEvent> = [];
    const sent: Array<OtlpTraces | null> = [];
    let authCalls = 0;
    let limitCalls = 0;
    let exportCalls = 0;
    initLogger({
      silent: true,
      drain: ({ event }) => {
        events.push(event);
      },
    });
    const cloud = makeMemoryCloud();
    const authenticate: CloudSessions.CloudSessions["Service"]["authenticate"] = (credentials) => {
      authCalls++;
      return options.authorized === false ||
        (credentials.bearer !== "session" && credentials.cookie !== "session")
        ? Effect.fail(new CloudSessions.CloudCredentialError({ reason: "invalid_credential" }))
        : Effect.succeed({
            userId: PERSON,
            sessionId: AuthSessionId.make("session_test"),
            method: "bearer-access-token",
            scopes: [],
            expiresAt: Number.MAX_SAFE_INTEGER,
          });
    };
    const userDirectory: UserDirectory.UserDirectory["Service"] = {
      ...cloud.userDirectory,
      forUser: (id) => ({
        ...cloud.userDirectory.forUser(id),
        clientTraceDimensions: (ids) =>
          Effect.succeed(
            ids.includes(THREAD) ? [{ threadId: THREAD, folderId: FOLDER, orgId: null }] : [],
          ),
        clientFolderDimensions: (ids) =>
          Effect.succeed(ids.includes(FOLDER) ? [{ folderId: FOLDER, orgId: null }] : []),
      }),
    };
    const services = ClientIssueIntake.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
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
          ClientTraceExport.layer({
            TRACE_EXPORT_TOKEN: "write-only-test-key",
            ...(options.telemetry === undefined
              ? {}
              : { T3CODE_TELEMETRY_ENABLED: options.telemetry }),
            TRACE_EXPORT: {
              fetch: async (request) => {
                exportCalls++;
                if (options.failExport) throw new Error(CANARY);
                const body = await new Request(request).text();
                sent.push(filterTraces(JSON.parse(body), { stage: "pr-test", version: "9.8.7" }));
                return new Response(null, { status: 200 });
              },
            },
          }),
          ClientTraceLimits.layer(
            options.limited === false
              ? undefined
              : {
                  limit: async () => {
                    limitCalls++;
                    return { success: true };
                  },
                },
          ),
          Layer.succeed(UserDirectory.UserDirectory, userDirectory),
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                SIGNALBOX_STAGE: "pr-test",
                APP_VERSION: "9.8.7",
                ENVIRONMENT_ID: "server-environment",
                ...(options.telemetry === undefined
                  ? {}
                  : { T3CODE_TELEMETRY_ENABLED: options.telemetry }),
              },
            }),
          ),
          Evlog.layer,
        ),
      ),
    );
    const context = yield* Layer.build(services);
    const router = yield* HttpRouter.toHttpEffect(Routes.layer);
    const handler = HttpEffect.toWebHandler(
      router.pipe(Effect.provide(context), Effect.provide(Evlog.layer)),
    );
    const post = (body = JSON.stringify(payload()), headers: Record<string, string> = {}) =>
      Effect.promise(() =>
        handler(
          new Request(`https://cloud.test${CLIENT_ISSUES_PATH}`, {
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
      context,
      events,
      sent,
      authCalls: () => authCalls,
      limitCalls: () => limitCalls,
      exportCalls: () => exportCalls,
    };
  });

describe("cloud client issue intake", () => {
  it.effect("rebuilds a trusted issue event and joined trace without private input", () =>
    Effect.gen(function* () {
      const { post, events, sent } = yield* setup();
      const response = yield* post(
        JSON.stringify({ ...payload(), message: CANARY, stack: CANARY, body: CANARY }),
        { traceparent: `00-${TRACE}-${SPAN}-01` },
      );
      expect(response.status).toBe(204);
      expect(sent).toHaveLength(1);
      const output = JSON.stringify({ events, sent });
      expect(output).not.toContain(CANARY);
      expect(output).not.toContain(FORGED_FOLDER);
      expect(output).not.toContain("claimed-environment");
      expect(output).toContain(PERSON);
      expect(output).toContain(THREAD);
      expect(output).toContain(FOLDER);
      expect(output).toContain("server-environment");
      expect(output).toContain("9.8.7");
      expect(output).toContain("1.2.3");
      expect(output).toContain(METHOD);
      expect(sent[0]?.resourceSpans).toHaveLength(1);
      const spans = sent[0]?.resourceSpans[0]?.scopeSpans[0]?.spans;
      expect(spans).toHaveLength(1);
      expect(spans?.[0]).toMatchObject({
        traceId: TRACE,
        parentSpanId: SPAN,
        name: "client.issue.intake",
        status: { code: 0 },
      });
      const issueEvent = events.find((event) => event.action === "client.issue.rpc.failed");
      expect(issueEvent).toBeDefined();
      const sentryIssue = toSentryErrorEvent(issueEvent!, { dsn: "https://public@example.com/1" });
      expect(sentryIssue).toBeTruthy();
      expect(issueEvent?.level).toBe("error");
      const sentryLog = toSentryLog(issueEvent!, { dsn: "https://public@example.com/1" });
      expect(JSON.stringify(issueEvent)).toContain("clientIssue");
      expect(JSON.stringify(sentryLog)).toContain("environmentId");
      expect(sentryIssue.contexts.trace.trace_id).toBe(TRACE);
    }),
  );

  it.effect(
    "accepts accessible folder-only context and drops stale context and invalid metadata",
    () =>
      Effect.gen(function* () {
        const { post, sent, events } = yield* setup();
        expect(
          (yield* post(
            JSON.stringify(
              payload({
                threadId: null,
                folderId: FOLDER,
                method: CANARY,
              }),
            ),
            { traceparent: `00-${TRACE}-${SPAN}-01` },
          )).status,
        ).toBe(204);
        expect(JSON.stringify(sent[0])).toContain(FOLDER);
        expect(JSON.stringify(sent[0])).not.toContain(CANARY);

        expect(
          (yield* post(JSON.stringify(payload({ threadId: THREAD, folderId: FORGED_FOLDER })), {
            traceparent: `00-${TRACE}-${SPAN}-01`,
          })).status,
        ).toBe(204);
        expect(JSON.stringify(sent[1])).toContain(FOLDER);
        expect(JSON.stringify(sent[1])).not.toContain(FORGED_FOLDER);

        expect(
          (yield* post(JSON.stringify(payload({ threadId: null, folderId: FORGED_FOLDER })), {
            traceparent: `00-${TRACE}-${SPAN}-01`,
          })).status,
        ).toBe(204);
        expect(JSON.stringify(sent[2])).not.toContain(FORGED_FOLDER);
        const staleEvent = events.findLast((event) => event.action === "client.issue.rpc.failed");
        expect(staleEvent).toBeDefined();
        expect(JSON.stringify(staleEvent)).toContain('"folderId":null');
      }),
  );

  it.effect(
    "authenticates and rate limits before decoding, and fails closed when the limiter is missing",
    () =>
      Effect.gen(function* () {
        const denied = yield* setup({ authorized: false });
        expect((yield* denied.post("invalid", { authorization: "" })).status).toBe(401);
        expect(denied.authCalls()).toBe(1);
        expect(denied.limitCalls()).toBe(0);

        const cookieSession = yield* setup();
        expect(
          (yield* cookieSession.post(undefined, {
            authorization: "",
            cookie: "signalbox_cloud_session=session",
          })).status,
        ).toBe(204);

        const unmetered = yield* setup({ limited: false });
        expect((yield* unmetered.post("invalid")).status).toBe(429);
        expect(unmetered.sent).toHaveLength(0);
        expect(unmetered.events).toHaveLength(0);
      }),
  );

  it.effect("bounds JSON intake and rejects invalid codes, release values, and trace joins", () =>
    Effect.gen(function* () {
      const { post, sent, events } = yield* setup();
      expect((yield* post("not json")).status).toBe(400);
      expect((yield* post("x".repeat(16 * 1024 + 1))).status).toBe(413);
      expect((yield* post(undefined, { "content-length": "16385" })).status).toBe(413);
      expect((yield* post(undefined, { "content-type": "text/plain" })).status).toBe(415);
      expect((yield* post(undefined, { "content-encoding": "gzip" })).status).toBe(415);
      expect((yield* post(JSON.stringify(payload({ code: CANARY })))).status).toBe(400);
      expect((yield* post(JSON.stringify(payload({ release: CANARY })))).status).toBe(400);
      const mismatch = yield* post(JSON.stringify(payload()), {
        traceparent: `00-${OTHER_TRACE}-${OTHER_SPAN}-01`,
      });
      expect(mismatch.status).toBe(400);
      const mismatchBody = yield* Effect.promise(() => mismatch.text());
      expect(mismatchBody).not.toContain(OTHER_TRACE);
      expect(sent).toHaveLength(0);
      expect(events).toHaveLength(0);
    }),
  );

  it.effect("caps contract-valid client release metadata before event or trace export", () =>
    Effect.gen(function* () {
      const { post, sent, events } = yield* setup();
      const longRelease = `1.2.3-${"a".repeat(80)}.1`;
      expect(
        (yield* post(JSON.stringify(payload({ release: longRelease })), {
          traceparent: `00-${TRACE}-${SPAN}-01`,
        })).status,
      ).toBe(204);
      const output = JSON.stringify({ sent, events });
      expect(output).not.toContain(longRelease);
      expect(output).toContain('"clientRelease":"unknown"');
    }),
  );

  it.effect(
    "times out a stalled body, suppresses disabled telemetry, and does not recurse on export failure",
    () =>
      Effect.gen(function* () {
        const stalled = yield* setup();
        const intake = Context.get(stalled.context, ClientIssueIntake.ClientIssueIntake);
        const started = yield* Deferred.make<void>();
        const fiber = yield* Effect.forkChild(
          intake
            .ingest({
              credentials: { bearer: "session" },
              contentType: "application/json",
              contentEncoding: undefined,
              contentLength: undefined,
              traceparent: undefined,
              body: Stream.unwrap(
                Deferred.succeed(started, undefined).pipe(Effect.as(Stream.never)),
              ),
            })
            .pipe(Effect.flip),
        );
        yield* Deferred.await(started);
        yield* TestClock.adjust("5 seconds");
        expect(yield* Fiber.join(fiber)).toMatchObject({ status: 408 });

        const disabled = yield* setup({ telemetry: "false" });
        expect((yield* disabled.post("not json")).status).toBe(204);
        expect(disabled.authCalls()).toBe(1);
        expect(disabled.events).toHaveLength(0);
        expect(disabled.exportCalls()).toBe(0);

        const failed = yield* setup({ failExport: true });
        expect(
          (yield* failed.post(undefined, { traceparent: `00-${TRACE}-${SPAN}-01` })).status,
        ).toBe(204);
        expect(
          failed.events.filter((event) => event.action === "client.issue.rpc.failed"),
        ).toHaveLength(1);
        expect(JSON.stringify(failed.events)).not.toContain(CANARY);
      }),
  );

  it.effect("routes warning issues to warning events", () =>
    Effect.gen(function* () {
      const { post, events, sent } = yield* setup();
      expect(
        (yield* post(
          JSON.stringify(
            payload({
              severity: "warning",
              source: "ui",
              code: "toast.warning",
              client: "desktop",
            }),
          ),
          { traceparent: `00-${TRACE}-${SPAN}-01` },
        )).status,
      ).toBe(204);
      const event = events.find((candidate) => candidate.action === "client.issue.toast.warning");
      expect(event).toBeDefined();
      expect(event?.level).toBe("warn");
      expect(toSentryLog(event!, { dsn: "https://public@example.com/1" }).level).toBe("warn");
      expect(sent[0]?.resourceSpans).toHaveLength(2);
      expect(sent[0]?.resourceSpans[0]?.resource.attributes).toContainEqual({
        key: "service.name",
        value: { stringValue: "t3code-desktop" },
      });
      expect(sent[0]?.resourceSpans[0]?.scopeSpans[0]?.spans[0]).toMatchObject({
        name: "client.issue",
        traceId: TRACE,
        spanId: SPAN,
        status: { code: 0 },
      });
      expect(sent[0]?.resourceSpans[1]?.scopeSpans[0]?.spans[0]?.parentSpanId).toBe(SPAN);
    }),
  );
});
