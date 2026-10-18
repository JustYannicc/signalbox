import {
  AuthOrchestrationReadScope,
  AuthStandardClientScopes,
  EnvironmentId,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import type { SignalboxAsk } from "@t3tools/contracts/signalboxAsks";
import { SIGNALBOX_PUSH_WS_METHODS } from "@t3tools/contracts/signalboxPush";
import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as RpcTest from "effect/rpc/RpcTest";
import * as TestClock from "effect/testing/TestClock";
import { ConnectionError, SqlError } from "effect/sql/SqlError";
import { HttpClient, HttpClientResponse } from "effect/http";

import { layerMemoryStore, makeMemoryCloud } from "../testing.ts";
import * as CloudRpc from "../user/rpc.ts";
import * as UserStore from "../user/UserStore.ts";
import * as PushDevices from "./PushDevices.ts";
import * as PushNotifier from "./PushNotifier.ts";
import { FRESH_MS, LONG_TURN_MS, pushFor, wants } from "./pushRules.ts";

const environmentId = EnvironmentId.make("cloud-test");
const T0 = Date.parse("2026-10-15T12:00:00.000Z");
const at = (ms: number) => DateTime.makeUnsafe(T0 + ms);

/** A cloud thread's sidebar row; `run` starts at T0. */
const shell = (
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell => ({
  createdBy: "user",
  creationSource: "web",
  id: ThreadId.make("thread-1"),
  projectId: ProjectId.make("project-1"),
  title: "Fix the login bug",
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  lineage: {
    rootThreadId: ThreadId.make("thread-1"),
    parentThreadId: null,
    relationshipToParent: null,
  },
  forkedFrom: null,
  activeProviderThreadId: null,
  latestRunId: RunId.make("run-1"),
  latestRunStartedAt: at(0),
  latestRunCompletedAt: null,
  activeRunId: RunId.make("run-1"),
  activityRunStatus: "running",
  status: "running",
  pendingRuntimeRequest: null,
  latestVisibleMessage: null,
  latestUserMessageAt: null,
  hasActionableProposedPlan: false,
  pendingBackgroundTasks: [],
  providerInstanceHistory: [],
  itemCount: 0,
  visibleItemCount: 0,
  createdAt: at(0),
  updatedAt: at(0),
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  ...overrides,
});

const running = shell();
const waiting = (kind: "user_input" | "command", request = "request-1") =>
  shell({
    updatedAt: at(1_000),
    pendingRuntimeRequest: { id: RuntimeRequestId.make(request), kind, createdAt: at(1_000) },
  });
const ended = (status: "completed" | "failed", afterMs: number) =>
  shell({
    status,
    activityRunStatus: null,
    activeRunId: null,
    latestRunCompletedAt: at(afterMs),
    updatedAt: at(afterMs),
  });

describe("pushFor", () => {
  const push = (
    previous: OrchestrationV2ThreadShell | null,
    next: OrchestrationV2ThreadShell,
    now = T0 + 70_000,
  ) => pushFor({ environmentId, previous, next, now });

  const blocker = (id = "ask", round = 1): SignalboxAsk => ({
    id,
    kind: "blocker",
    status: "pending",
    source: { kind: "agent" },
    createdAt: "2026-10-15T12:00:00.000Z",
    updatedAt: "2026-10-15T12:00:00.000Z",
    questions: [
      {
        id: "question",
        question: "Proceed?",
        why: "Need your decision",
        unblocks: "Delivery",
        recommendation: "Yes",
        options: [],
        blocking: true,
        decisionOwner: "You",
        surface: { kind: "kit", component: "choice" },
      },
    ],
    rounds: [
      {
        number: round,
        questionIds: ["question"],
        answers: [],
        deferredQuestionIds: [],
        openedAt: "2026-10-15T12:00:00.000Z",
        closedAt: null,
      },
    ],
  });

  it("deduplicates durable blockers by ask and round after the turn has finished", () => {
    const finished = ended("completed", 70_000);
    const first = { ...finished, asks: [blocker()] };
    expect(push(finished, first)?.phase).toBe("waiting_for_input");
    expect(push(first, { ...first, updatedAt: at(80_000) })).toBeNull();
    expect(push(first, { ...first, asks: [blocker("ask", 2)] })?.phase).toBe("waiting_for_input");
    expect(push(first, { ...first, asks: [blocker("other")] })?.phase).toBe("waiting_for_input");
  });

  it("does not push Ready, Considering, or nonblocking asks", () => {
    for (const ask of [
      { ...blocker(), kind: "ready" },
      { ...blocker(), kind: "considering" },
      { ...blocker(), questions: [{ ...blocker().questions[0], blocking: false }] },
    ] satisfies SignalboxAsk[]) {
      expect(push(running, shell({ asks: [ask] }))).toBeNull();
    }
  });

  it("pushes a thread that starts waiting for an answer or an approval, once", () => {
    expect(push(running, waiting("user_input"))).toEqual({
      phase: "waiting_for_input",
      environmentId: "cloud-test",
      threadId: "thread-1",
      group: "thread-1",
      title: "Fix the login bug",
      body: "Has a question for you",
      deepLink: "/threads/cloud-test/thread-1",
    });
    expect(push(running, waiting("command"))?.phase).toBe("waiting_for_approval");
    expect(push(waiting("user_input"), waiting("user_input"))).toBeNull();
  });

  it("pushes a new request even when the summary skipped the answer to the last one", () => {
    expect(push(waiting("command"), waiting("command", "request-2"))?.phase).toBe(
      "waiting_for_approval",
    );
  });

  it("treats the first summary it sees as a baseline", () => {
    expect(push(null, waiting("user_input"))).toBeNull();
  });

  it("pushes a fresh failure, however short the turn", () => {
    expect(push(running, ended("failed", 5_000), T0 + 6_000)?.body).toBe("Stopped with an error");
    expect(push(ended("failed", 5_000), ended("failed", 5_000), T0 + 6_000)).toBeNull();
    expect(push(running, ended("failed", 5_000), T0 + 5_000 + FRESH_MS + 1)).toBeNull();
  });

  it("pushes a finish only for long turns", () => {
    expect(push(running, ended("completed", LONG_TURN_MS), T0 + LONG_TURN_MS)?.phase).toBe(
      "completed",
    );
    expect(push(running, ended("completed", LONG_TURN_MS - 1), T0 + LONG_TURN_MS)).toBeNull();
  });

  it("pushes a new run that finished even when the previous one had too", () => {
    const next = { ...ended("failed", 5_000), latestRunId: RunId.make("run-2") };
    expect(push(ended("failed", 1_000), next, T0 + 6_000)?.phase).toBe("failed");
  });

  it("stays quiet for subagents and archived threads", () => {
    const lineage = {
      rootThreadId: ThreadId.make("parent"),
      parentThreadId: ThreadId.make("parent"),
      relationshipToParent: "subagent" as const,
    };
    expect(push({ ...running, lineage }, { ...waiting("user_input"), lineage })).toBeNull();
    expect(push(running, { ...waiting("user_input"), archivedAt: at(1_000) })).toBeNull();
  });

  it("asks each phone's preferences", () => {
    const preferences = {
      liveActivitiesEnabled: true,
      notificationsEnabled: true,
      notifyOnApproval: true,
      notifyOnInput: true,
      notifyOnCompletion: false,
      notifyOnFailure: true,
    };
    expect(wants(preferences, "waiting_for_input")).toBe(true);
    expect(wants(preferences, "completed")).toBe(false);
    expect(wants({ ...preferences, notificationsEnabled: false }, "failed")).toBe(false);
  });
});

/** A P-256 key as Apple issues it (`.p8`, PKCS#8 PEM), and its public half to check signatures. */
const apnsKey = Effect.promise(async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----`;
  return { pem, publicKey: pair.publicKey };
});

interface Sent {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

/** Answers every request with `status`/`body` and records what was sent. */
const fakeApple = (status: number, body = "") => {
  const sent: Array<Sent> = [];
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        const bytes = request.body._tag === "Uint8Array" ? request.body.body : new Uint8Array();
        sent.push({
          url: request.url,
          headers: request.headers,
          body: JSON.parse(new TextDecoder().decode(bytes)),
        });
        return HttpClientResponse.fromWeb(request, new Response(body || null, { status }));
      }),
    ),
  );
  return { sent, layer };
};

const registration = {
  deviceId: "phone-1",
  label: "Test iPhone",
  platform: "ios" as const,
  iosMajorVersion: 26,
  bundleId: "com.justyannicc.signalbox",
  apsEnvironment: "production" as const,
  pushToken: "aabbcc",
  preferences: {
    liveActivitiesEnabled: true,
    notificationsEnabled: true,
    notifyOnApproval: true,
    notifyOnInput: true,
    notifyOnCompletion: true,
    notifyOnFailure: true,
  },
};

const layerPushes = (
  http: Layer.Layer<HttpClient.HttpClient>,
  env: Record<string, string>,
  isSessionActive?: Parameters<typeof PushNotifier.layerWithDevices>[1],
) =>
  Layer.unwrap(
    Effect.map(UserStore.UserStore, (store) =>
      PushNotifier.layerWithDevices(
        environmentId,
        isSessionActive ??
          ((sid) => Effect.map(store.findSession(sid), (session) => session !== null)),
      ),
    ),
  ).pipe(
    Layer.provide(Layer.mergeAll(http, ConfigProvider.layer(ConfigProvider.fromEnv({ env })))),
    Layer.provideMerge(layerMemoryStore),
  );

/** A signed-in phone and the services around it. */
const withPhone = Effect.gen(function* () {
  yield* TestClock.setTime(T0 + 1_000);
  const store = yield* UserStore.UserStore;
  const session = yield* store.createSession({
    method: "bearer-access-token",
    scopes: AuthStandardClientScopes,
    ttlMs: 60 * 60_000,
  });
  if (session === null) throw new Error("expected a session");
  const devices = yield* PushDevices.PushDevices;
  yield* devices.register(session.sid, registration);
  return { store, devices, session, notifier: yield* PushNotifier.PushNotifier };
});

describe("PushNotifier", () => {
  it.effect("sends APNs an alert that opens the thread, signed with the team's key", () =>
    Effect.gen(function* () {
      const key = yield* apnsKey;
      const apple = fakeApple(200);
      yield* Effect.gen(function* () {
        const { notifier } = yield* withPhone;
        yield* notifier.threadChanged({ previous: running, next: waiting("user_input") });
      }).pipe(
        Effect.provide(
          layerPushes(apple.layer, {
            APNS_TEAM_ID: "TEAM123456",
            APNS_KEY_ID: "KEY1234567",
            APNS_PRIVATE_KEY: key.pem,
          }),
        ),
      );

      expect(apple.sent).toHaveLength(1);
      const [request] = apple.sent;
      expect(request?.url).toBe("https://api.push.apple.com/3/device/aabbcc");
      expect(request?.headers).toMatchObject({
        "apns-push-type": "alert",
        "apns-topic": "com.justyannicc.signalbox",
        "apns-collapse-id": "thread-1",
      });
      expect(request?.body).toEqual({
        aps: {
          alert: { title: "Fix the login bug", body: "Has a question for you" },
          sound: "default",
          "thread-id": "cloud-test/thread-1",
        },
        environmentId: "cloud-test",
        threadId: "thread-1",
        deepLink: "/threads/cloud-test/thread-1",
      });

      const jwt = (request?.headers.authorization ?? "").replace(/^bearer /, "");
      const [header, claims, signature] = jwt.split(".");
      const decode = (part: string | undefined) =>
        JSON.parse(new TextDecoder().decode(Result.getOrThrow(Base64Url.decode(part ?? ""))));
      expect(decode(header)).toEqual({ alg: "ES256", kid: "KEY1234567" });
      expect(decode(claims)).toEqual({ iss: "TEAM123456", iat: Math.floor((T0 + 1_000) / 1000) });
      const verified = yield* Effect.promise(() =>
        crypto.subtle.verify(
          { name: "ECDSA", hash: "SHA-256" },
          key.publicKey,
          new Uint8Array(Result.getOrThrow(Base64Url.decode(signature ?? ""))),
          new TextEncoder().encode(`${header}.${claims}`),
        ),
      );
      expect(verified).toBe(true);
    }),
  );

  it.effect("forgets a phone Apple says is gone", () =>
    Effect.gen(function* () {
      const key = yield* apnsKey;
      const apple = fakeApple(410, JSON.stringify({ reason: "Unregistered" }));
      const left = yield* Effect.gen(function* () {
        const { notifier, devices } = yield* withPhone;
        yield* notifier.threadChanged({ previous: running, next: waiting("user_input") });
        return yield* devices.list;
      }).pipe(
        Effect.provide(
          layerPushes(apple.layer, {
            APNS_TEAM_ID: "TEAM123456",
            APNS_KEY_ID: "KEY1234567",
            APNS_PRIVATE_KEY: key.pem,
          }),
        ),
      );
      expect(apple.sent).toHaveLength(1);
      expect(left).toEqual([]);
    }),
  );

  it.effect("stops pushing to a phone whose session was revoked", () =>
    Effect.gen(function* () {
      const key = yield* apnsKey;
      const apple = fakeApple(200);
      const left = yield* Effect.gen(function* () {
        const { notifier, devices, store, session } = yield* withPhone;
        yield* store.revokeSession(session.sid);
        yield* notifier.threadChanged({ previous: running, next: waiting("user_input") });
        return yield* devices.list;
      }).pipe(
        Effect.provide(
          layerPushes(apple.layer, {
            APNS_TEAM_ID: "TEAM123456",
            APNS_KEY_ID: "KEY1234567",
            APNS_PRIVATE_KEY: key.pem,
          }),
        ),
      );
      expect(apple.sent).toEqual([]);
      expect(left).toEqual([]);
    }),
  );

  it.effect("stops pushing when the registering session expires", () =>
    Effect.gen(function* () {
      const key = yield* apnsKey;
      const apple = fakeApple(200);
      const left = yield* Effect.gen(function* () {
        const { notifier, devices } = yield* withPhone;
        yield* TestClock.adjust("1 hour");
        yield* notifier.threadChanged({ previous: running, next: waiting("user_input") });
        return yield* devices.list;
      }).pipe(
        Effect.provide(
          layerPushes(apple.layer, {
            APNS_TEAM_ID: "TEAM123456",
            APNS_KEY_ID: "KEY1234567",
            APNS_PRIVATE_KEY: key.pem,
          }),
        ),
      );
      expect(apple.sent).toEqual([]);
      expect(left).toEqual([]);
    }),
  );

  it.effect("keeps registrations and skips delivery when the session check fails", () =>
    Effect.gen(function* () {
      const key = yield* apnsKey;
      const apple = fakeApple(200);
      const checked: Array<string> = [];
      const left = yield* Effect.gen(function* () {
        const { notifier, devices, session } = yield* withPhone;
        yield* notifier.threadChanged({ previous: running, next: waiting("user_input") });
        expect(checked).toEqual([session.sid]);
        return yield* devices.list;
      }).pipe(
        Effect.provide(
          layerPushes(
            apple.layer,
            {
              APNS_TEAM_ID: "TEAM123456",
              APNS_KEY_ID: "KEY1234567",
              APNS_PRIVATE_KEY: key.pem,
            },
            (sid) =>
              Effect.gen(function* () {
                checked.push(sid);
                return yield* new SqlError({
                  reason: new ConnectionError({ cause: new Error("session unavailable") }),
                });
              }),
          ),
        ),
      );
      expect(apple.sent).toEqual([]);
      expect(left).toHaveLength(1);
    }),
  );

  it.effect("keeps the phone and sends nothing while APNs isn't configured", () =>
    Effect.gen(function* () {
      const apple = fakeApple(200);
      const left = yield* Effect.gen(function* () {
        const { notifier, devices } = yield* withPhone;
        yield* notifier.threadChanged({ previous: running, next: waiting("user_input") });
        return yield* devices.list;
      }).pipe(Effect.provide(layerPushes(apple.layer, {})));
      expect(apple.sent).toEqual([]);
      expect(left.map((device) => device.deviceId)).toEqual(["phone-1"]);
    }),
  );
});

/** A Firebase service account with a fresh RSA key. */
const serviceAccount = Effect.promise(async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  return JSON.stringify({
    project_id: "signalbox-test",
    client_email: "push@example.com",
    private_key: `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----`,
  });
});

/** Google: a token for the assertion, then `send` answers every message. */
const fakeGoogle = (send: { readonly status: number; readonly body: unknown }) => {
  const sent: Array<Sent> = [];
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        if (request.url === "https://oauth2.googleapis.com/token") {
          return HttpClientResponse.fromWeb(
            request,
            Response.json({ access_token: "google-token", expires_in: 3600 }),
          );
        }
        const bytes = request.body._tag === "Uint8Array" ? request.body.body : new Uint8Array();
        sent.push({
          url: request.url,
          headers: request.headers,
          body: JSON.parse(new TextDecoder().decode(bytes)),
        });
        return HttpClientResponse.fromWeb(
          request,
          Response.json(send.body, { status: send.status }),
        );
      }),
    ),
  );
  return { sent, layer };
};

const android = {
  ...registration,
  deviceId: "pixel-1",
  label: "Pixel",
  platform: "android" as const,
  iosMajorVersion: undefined,
  apsEnvironment: undefined,
  androidApiLevel: 35,
  bundleId: "com.justyannicc.signalbox",
  pushToken: "fcm-token",
};

const withAndroid = Effect.gen(function* () {
  yield* TestClock.setTime(T0 + 1_000);
  const store = yield* UserStore.UserStore;
  const session = yield* store.createSession({
    method: "bearer-access-token",
    scopes: AuthStandardClientScopes,
    ttlMs: 60 * 60_000,
  });
  if (session === null) throw new Error("expected a session");
  const devices = yield* PushDevices.PushDevices;
  const { iosMajorVersion: _ios, apsEnvironment: _aps, ...phone } = android;
  yield* devices.register(session.sid, phone);
  const notifier = yield* PushNotifier.PushNotifier;
  yield* notifier.threadChanged({ previous: running, next: ended("failed", 900) });
  return yield* devices.list;
});

describe("PushNotifier on Android", () => {
  it.effect("sends FCM a notification that opens the thread", () =>
    Effect.gen(function* () {
      const google = fakeGoogle({ status: 200, body: { name: "sent" } });
      const left = yield* withAndroid.pipe(
        Effect.provide(layerPushes(google.layer, { FCM_SERVICE_ACCOUNT: yield* serviceAccount })),
      );
      expect(google.sent.map((request) => request.url)).toEqual([
        "https://fcm.googleapis.com/v1/projects/signalbox-test/messages:send",
      ]);
      expect(google.sent[0]?.body).toMatchObject({
        message: {
          token: "fcm-token",
          notification: { title: "Fix the login bug", body: "Stopped with an error" },
          data: { deepLink: "/threads/cloud-test/thread-1", threadId: "thread-1" },
          android: { restricted_package_name: "com.justyannicc.signalbox" },
        },
      });
      expect(left).toHaveLength(1);
    }),
  );

  it.effect("forgets a phone only when FCM says the token is unregistered", () =>
    Effect.gen(function* () {
      const account = yield* serviceAccount;
      const unregistered = fakeGoogle({
        status: 404,
        body: { error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } },
      });
      expect(
        yield* withAndroid.pipe(
          Effect.provide(layerPushes(unregistered.layer, { FCM_SERVICE_ACCOUNT: account })),
        ),
      ).toEqual([]);
      // A wrong project is also a 404, and says nothing about the phone.
      const wrongProject = fakeGoogle({ status: 404, body: { error: { status: "NOT_FOUND" } } });
      expect(
        yield* withAndroid.pipe(
          Effect.provide(layerPushes(wrongProject.layer, { FCM_SERVICE_ACCOUNT: account })),
        ),
      ).toHaveLength(1);
    }),
  );
});

describe("signalbox.push RPCs", () => {
  it.effect("register a phone under the socket's session and forget it again", () =>
    Effect.gen(function* () {
      const cloud = makeMemoryCloud();
      const userId = "user_1";
      yield* cloud.userDirectory.forUser(userId).recordSignIn({ id: userId, email: "a@b.c" });
      const rpc = yield* RpcTest.makeClient(CloudRpc.CloudRpcGroup).pipe(
        Effect.provide(
          Layer.mergeAll(
            CloudRpc.layerHandlers({
              identity: { environmentId, label: "Cloud" },
              userId,
              sid: "session-1",
            }),
            CloudRpc.layerScopeAuthorization([AuthOrchestrationReadScope]),
          ).pipe(Layer.provide(cloud.layerFor(userId))),
        ),
      );
      const list = PushDevices.PushDevices.use((devices) => devices.list).pipe(
        Effect.provide(cloud.layerFor(userId)),
      );

      yield* rpc[SIGNALBOX_PUSH_WS_METHODS.registerDevice](registration);
      expect((yield* list).map(({ deviceId, sid }) => ({ deviceId, sid }))).toEqual([
        { deviceId: "phone-1", sid: "session-1" },
      ]);
      // Notifications turned off on the phone: no token, nothing to reach.
      const { pushToken: _, ...withoutToken } = registration;
      yield* rpc[SIGNALBOX_PUSH_WS_METHODS.registerDevice](withoutToken);
      expect(yield* list).toEqual([]);

      yield* rpc[SIGNALBOX_PUSH_WS_METHODS.registerDevice](registration);
      yield* rpc[SIGNALBOX_PUSH_WS_METHODS.unregisterDevice]({ deviceId: "phone-1" });
      expect(yield* list).toEqual([]);
    }).pipe(Effect.scoped),
  );
});
