// @effect-diagnostics anyUnknownInErrorContext:off - ScratchStack.deploy is typed with `any` in its error channel by Alchemy.
import { adopt } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { inMemoryState } from "alchemy/State";
import * as Test from "alchemy/Test/Vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";
import { beforeEach, describe, expect } from "vite-plus/test";

import { ApiKey, ApiKeyProvider } from "./ApiKey.ts";
import { fromApiKey } from "./Credentials.ts";
import { Environment, EnvironmentProvider } from "./Environment.ts";
import { NamedSnapshot, NamedSnapshotProvider } from "./NamedSnapshot.ts";
import { Providers } from "./Providers.ts";

// An in-memory Boat that records every mutating call, so the tests prove
// what adoption does NOT do (rebuild, rotate, overwrite, delete) without
// touching a real account.
const now = "2026-10-17T00:00:00Z";
let seq = 0;
const nextId = (prefix: string) => `${prefix}_${++seq}`;
const fake = {
  calls: [] as string[],
  snapshots: new Map<string, Record<string, unknown>>(),
  sandboxes: new Map<string, Record<string, unknown>>(),
  sandboxCreates: [] as Array<Record<string, unknown>>,
  sandboxReads: 0,
  lastSandboxId: undefined as string | undefined,
  environments: new Map<string, Record<string, unknown>>(),
  keys: new Map<string, Record<string, unknown>>(),
  setupStatuses: [] as Array<string | null>,
  setupError: undefined as string | undefined,
  firstSandboxRead: undefined as Deferred.Deferred<void> | undefined,
  // A restricted deploy key gets `apiKeys: []` from GET /api-keys.
  inventoryHidden: false,
};

const apiKey = (name: string, actions: string[], expiresAt = "2099-01-01T00:00:00Z") => ({
  id: nextId("sak"),
  name,
  credentialLane: "scoped-v1",
  keyPrefix: "boat_live",
  keyLastFour: "abcd",
  sandboxId: null,
  createdAt: now,
  lastUsedAt: null,
  usage: { requests: 0, windowDays: 30 },
  resources: { total: 0, sandboxes: 0, agents: 0 },
  expiresAt,
  expired: expiresAt < now,
  scope: { actions, sandboxes: "*", environments: "*" },
});

const snapshot = (name: string, status: string) => ({
  name,
  status,
  snapshotId: nextId("snp"),
  sourceSandboxId: nextId("bx"),
  type: "small",
  createdAt: now,
});

const environment = (name: string, isDefault: boolean) => {
  const versionId = nextId("env_version");
  return {
    id: nextId("env"),
    name,
    isDefault,
    latestVersionId: versionId,
    safeForThirdParties: false,
    passGithub: true,
    passSecrets: true,
    passSandboxCredentials: true,
    passAgentsCredentials: true,
    envContents: "",
    secretFiles: [],
    versions: [{ id: versionId, versionNumber: 1, sandboxCount: 0, createdAt: now }],
  };
};

const notFound = {
  status: 404,
  body: { ok: false, status: 404, code: "not_found", message: "Not found" },
};

const bodyRecord = (body: unknown): Record<string, unknown> =>
  typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};

const stringField = (body: unknown, key: string) => {
  const value = bodyRecord(body)[key];
  return typeof value === "string" ? value : "";
};

const stringArrayField = (body: unknown, key: string) => {
  const value = bodyRecord(body)[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
};

const route = (method: string, path: string, body: unknown): { status: number; body: unknown } => {
  if (method !== "GET") fake.calls.push(`${method} ${path}`);
  const seg = path.split("/").filter(Boolean);
  const request = bodyRecord(body);
  const ok = (value: unknown) => ({ status: 200, body: value });
  switch (`${method} /${seg[0]}`) {
    case "GET /named-snapshots": {
      if (seg[1] === undefined) {
        return ok({ ok: true, type: "snapshot.list", snapshots: [...fake.snapshots.values()] });
      }
      const found = fake.snapshots.get(decodeURIComponent(seg[1]));
      return found ? ok({ ok: true, type: "snapshot.named", snapshot: found }) : notFound;
    }
    case "POST /named-snapshots": {
      const name = stringField(request, "name");
      const saved = {
        ...snapshot(name, "ready"),
        sourceSandboxId: stringField(request, "sandboxId"),
      };
      fake.snapshots.set(name, saved);
      return ok({ ok: true, type: "snapshot.saving", status: "saving", snapshot: saved });
    }
    case "POST /sandboxes": {
      const id = nextId("bx");
      fake.sandboxCreates.push(request);
      fake.lastSandboxId = id;
      const sandbox = {
        id,
        name: "snapshot builder",
        state: "ready",
        desktopAvailable: false,
        snapshotAvailable: true,
        setupStatus:
          request.setupScript === undefined ? null : (fake.setupStatuses[0] ?? "pending"),
        setupError: fake.setupError ?? null,
      };
      fake.sandboxes.set(id, sandbox);
      return ok({
        ok: true,
        type: "sandbox.created",
        status: "ready",
        ttlSeconds: request.ttlSeconds ?? null,
        sandbox,
      });
    }
    case "GET /sandboxes": {
      const sandbox = fake.sandboxes.get(decodeURIComponent(seg[1] ?? ""));
      if (!sandbox) return notFound;
      fake.sandboxReads++;
      const nextSetupStatus = fake.setupStatuses.shift();
      if (nextSetupStatus !== undefined) sandbox.setupStatus = nextSetupStatus;
      return ok({ ok: true, type: "sandbox.info", sandbox });
    }
    case "DELETE /sandboxes": {
      fake.sandboxes.delete(decodeURIComponent(seg[1] ?? ""));
      return ok({
        ok: true,
        type: "sandbox.deleting",
        operation: {
          id: nextId("del"),
          kind: "sandbox",
          targetId: seg[1],
          reason: "user_request",
          status: "accepted",
          attemptCount: 0,
          requestedAt: now,
          completedAt: null,
        },
      });
    }
    case "GET /api-keys":
      return ok({
        ok: true,
        type: "api_key.list",
        apiKeys: fake.inventoryHidden ? [] : [...fake.keys.values()],
        catalog: {
          actions: [],
          presets: {},
          defaultTtl: "90d",
          maxTtl: "365d",
          scopedCreationEnabled: true,
        },
      });
    case "POST /api-keys": {
      if (seg[1] === "scoped") {
        const created = apiKey(
          stringField(request, "name"),
          stringArrayField(request, "actions").length > 0
            ? stringArrayField(request, "actions")
            : ["sandbox.read"],
        );
        fake.keys.set(created.id, created);
        return ok({
          ok: true,
          type: "api_key.created",
          apiKey: created,
          secret: `boat_live_new_${created.id}`,
          apiKeys: [],
        });
      }
      const existing = fake.keys.get(seg[1]!);
      return existing
        ? ok({
            ok: true,
            type: "api_key.rotated",
            apiKey: existing,
            secret: `boat_live_rotated_${existing.id}`,
            apiKeys: [],
          })
        : notFound;
    }
    case "DELETE /api-keys":
      fake.keys.delete(seg[1]!);
      return ok({ ok: true, type: "api_key.revoked", apiKeys: [] });
    case "DELETE /named-snapshots":
      fake.snapshots.delete(decodeURIComponent(seg[1]!));
      return ok({ ok: true, type: "snapshot.deleting", name: seg[1], status: "deleting" });
    case "GET /environments":
      return ok({ environments: [...fake.environments.values()] });
    case "POST /environments": {
      const created = environment(stringField(request, "name"), false);
      fake.environments.set(created.id, created);
      return ok({ environments: [...fake.environments.values()] });
    }
    case "PUT /environments": {
      const env = fake.environments.get(seg[1]!);
      if (!env) return notFound;
      const versions = Array.isArray(env.versions) ? env.versions : [];
      const versionId = nextId("env_version");
      versions.push({
        id: versionId,
        versionNumber: versions.length + 1,
        sandboxCount: 0,
        createdAt: now,
      });
      Object.assign(env, request, { latestVersionId: versionId, versions });
      return ok({ success: true, environment: env });
    }
    case "DELETE /environments":
      fake.environments.delete(seg[1]!);
      return ok({ success: true });
    default:
      return {
        status: 500,
        body: { ok: false, status: 500, code: "unrouted", message: `${method} ${path}` },
      };
  }
};

const fakeHttp = HttpClient.make((request) =>
  Effect.gen(function* () {
    const path = new URL(request.url).pathname.replace(/^\/api\/v1/, "");
    const raw =
      request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
    const routed = route(request.method, path, raw ? (JSON.parse(raw) as unknown) : undefined);
    if (request.method === "GET" && path.startsWith("/sandboxes/") && fake.firstSandboxRead) {
      const signal = fake.firstSandboxRead;
      fake.firstSandboxRead = undefined;
      yield* Deferred.succeed(signal, undefined);
    }
    const { status, body } = routed;
    return HttpClientResponse.fromWeb(
      request,
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  }),
);

const fakeProviders = Layer.effect(
  Providers,
  Provider.collection([ApiKey, Environment, NamedSnapshot]),
).pipe(
  Layer.provide(Layer.mergeAll(ApiKeyProvider(), EnvironmentProvider(), NamedSnapshotProvider())),
  Layer.provideMerge(fromApiKey({ apiKey: "boat_test", apiBaseUrl: "https://boat.test/api/v1" })),
  Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, fakeHttp)),
  Layer.provideMerge(TestClock.layer()),
);

const { test } = Test.make({ providers: fakeProviders, state: inMemoryState() });

beforeEach(() => {
  fake.calls.length = 0;
  fake.snapshots.clear();
  fake.sandboxes.clear();
  fake.sandboxCreates.length = 0;
  fake.sandboxReads = 0;
  fake.lastSandboxId = undefined;
  fake.environments.clear();
  fake.keys.clear();
  fake.setupStatuses.length = 0;
  fake.setupError = undefined;
  fake.firstSandboxRead = undefined;
  fake.inventoryHidden = false;
});

const actionOf = (plan: { resources: Record<string, unknown> }, logicalId: string) =>
  Object.values(plan.resources).flatMap((node) =>
    typeof node === "object" &&
    node !== null &&
    "action" in node &&
    "resource" in node &&
    typeof node.resource === "object" &&
    node.resource !== null &&
    "LogicalId" in node.resource &&
    node.resource.LogicalId === logicalId
      ? [node.action]
      : [],
  )[0];

const reveal = (secret: Redacted.Redacted<string> | undefined) =>
  secret === undefined ? undefined : Redacted.value(secret);

const RUNNER_ACTIONS = ["sandbox.create", "sandbox.read", "snapshot.read"];

describe("Boat.ApiKey", () => {
  test.provider("creates the runtime key, returns its secret, and keeps it on redeploy", (stack) =>
    Effect.gen(function* () {
      const runnerKey = ApiKey("RunnerKey", {
        name: "signalbox-alchemy-runner",
        ttl: "365d",
        actions: RUNNER_ACTIONS,
      });
      const created = yield* stack.deploy(runnerKey);
      expect(fake.calls).toEqual(["POST /api-keys/scoped"]);
      expect(reveal(created.secret)).toBe(`boat_live_new_${created.apiKeyId}`);
      expect(created.actions).toEqual([...RUNNER_ACTIONS].sort());
      expect(created.secretVersion).toBe(1);

      fake.calls.length = 0;
      const same = yield* stack.deploy(runnerKey);
      expect(fake.calls).toEqual([]);
      expect(same.apiKeyId).toBe(created.apiKeyId);
      expect(reveal(same.secret)).toBe(reveal(created.secret));
    }),
  );

  test.provider("adopting a key keeps its secret until secretVersion is raised", (stack) =>
    Effect.gen(function* () {
      const existing = apiKey("signalbox-alchemy-runner", RUNNER_ACTIONS);
      fake.keys.set(existing.id, existing);
      const props = { name: "signalbox-alchemy-runner", actions: RUNNER_ACTIONS };

      const adopted = yield* stack.deploy(ApiKey("RunnerKey", props).pipe(adopt(true)));
      expect(adopted.apiKeyId).toBe(existing.id);
      expect(adopted.secret).toBeUndefined();
      expect(fake.calls).toEqual([]);

      const rotated = yield* stack.deploy(ApiKey("RunnerKey", { ...props, secretVersion: 2 }));
      expect(rotated.apiKeyId).toBe(existing.id);
      expect(reveal(rotated.secret)).toBe(`boat_live_rotated_${existing.id}`);
      expect(fake.calls).toEqual([`POST /api-keys/${existing.id}/rotate`]);
    }),
  );

  test.provider("an adopted key with other actions plans a replacement", (stack) =>
    Effect.gen(function* () {
      const existing = apiKey("signalbox-alchemy-runner", ["sandbox.read"]);
      fake.keys.set(existing.id, existing);
      const plan = yield* stack.plan(
        ApiKey("RunnerKey", { name: "signalbox-alchemy-runner", actions: RUNNER_ACTIONS }).pipe(
          adopt(true),
        ),
      );
      expect(actionOf(plan, "RunnerKey")).toBe("replace");
      expect(fake.calls).toEqual([]);
    }),
  );

  test.provider("an expired key plans a replacement", (stack) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_792_195_200_000);
      const expired = apiKey("signalbox-alchemy-runner", RUNNER_ACTIONS, "2020-01-01T00:00:00Z");
      fake.keys.set(expired.id, expired);
      const plan = yield* stack.plan(
        ApiKey("RunnerKey", { name: "signalbox-alchemy-runner", actions: RUNNER_ACTIONS }).pipe(
          adopt(true),
        ),
      );
      expect(actionOf(plan, "RunnerKey")).toBe("replace");
      expect(fake.calls).toEqual([]);
    }),
  );

  test.provider("a restricted deploy key that can't list keys trusts state", (stack) =>
    Effect.gen(function* () {
      fake.inventoryHidden = true;
      const props = { name: "signalbox-alchemy-runner", actions: RUNNER_ACTIONS };
      const created = yield* stack.deploy(ApiKey("RunnerKey", props));
      expect(fake.calls).toEqual(["POST /api-keys/scoped"]);

      fake.calls.length = 0;
      const same = yield* stack.deploy(ApiKey("RunnerKey", props));
      expect(fake.calls).toEqual([]);
      expect(reveal(same.secret)).toBe(reveal(created.secret));

      const rotated = yield* stack.deploy(ApiKey("RunnerKey", { ...props, secretVersion: 2 }));
      expect(fake.calls).toEqual([`POST /api-keys/${created.apiKeyId}/rotate`]);
      expect(reveal(rotated.secret)).toBe(`boat_live_rotated_${created.apiKeyId}`);
    }),
  );
});

describe("Boat adoption", () => {
  test.provider(
    "keeps an adopted named snapshot and rebuilds it only on a buildVersion bump",
    (stack) =>
      Effect.gen(function* () {
        const existing = snapshot("signalbox-runner", "ready");
        fake.snapshots.set("signalbox-runner", existing);
        const image = (buildVersion?: number) =>
          NamedSnapshot("RunnerImage", {
            name: "signalbox-runner",
            sandboxId: "bx_source",
            ...(buildVersion !== undefined ? { buildVersion } : {}),
          });

        const adopted = yield* stack.deploy(image().pipe(adopt(true)));
        expect(adopted.snapshotId).toBe(existing.snapshotId);
        expect(adopted.adopted).toBe(true);
        yield* stack.deploy(image());
        expect(fake.calls).toEqual([]);

        const rebuilt = yield* stack.deploy(image(2));
        expect(fake.calls).toEqual(["POST /named-snapshots"]);
        expect(rebuilt.adopted).toBe(false);
      }),
  );

  test.provider("refuses to overwrite an adopted named snapshot that isn't ready", (stack) =>
    Effect.gen(function* () {
      fake.snapshots.set("signalbox-runner", snapshot("signalbox-runner", "failed"));
      const result = yield* stack
        .deploy(
          NamedSnapshot("RunnerImage", { name: "signalbox-runner", sandboxId: "bx_source" }).pipe(
            adopt(true),
          ),
        )
        .pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      expect(fake.calls).toEqual([]);
    }),
  );

  test.provider(
    "creates a no-env runner environment and leaves the default one on destroy",
    (stack) =>
      Effect.gen(function* () {
        const base = environment("base", true);
        fake.environments.set(base.id, base);

        const runner = yield* stack.deploy(
          Effect.gen(function* () {
            yield* Environment("Base", { name: "base" }).pipe(adopt(true));
            return yield* Environment("RunnerEnvironment", {
              name: "signalbox-runner",
              safeForThirdParties: true,
            });
          }),
        );
        expect(runner.safeForThirdParties).toBe(true);
        expect(runner.latestVersionNumber).toBe(2);
        expect(fake.calls).toEqual([
          "POST /environments",
          `PUT /environments/${runner.environmentId}`,
        ]);

        fake.calls.length = 0;
        yield* stack.destroy();
        expect(fake.calls).toEqual([`DELETE /environments/${runner.environmentId}`]);
        expect(fake.environments.has(base.id)).toBe(true);
      }),
  );
});

describe("Boat snapshot builds", () => {
  const image = (props: { from?: string; setupScript?: string }) =>
    NamedSnapshot("RunnerImage", {
      name: "signalbox-runner",
      type: "small",
      ...props,
    });

  test.provider("waits for a setup script before saving and deletes the builder", (stack) =>
    Effect.gen(function* () {
      fake.setupStatuses.push(null, "pending", "done");
      const firstRead = yield* Deferred.make<void>();
      fake.firstSandboxRead = firstRead;
      const build = yield* Effect.forkChild(
        stack.deploy(image({ setupScript: "install the runner" })),
      );

      yield* Deferred.await(firstRead);
      expect(fake.calls).toEqual(["POST /sandboxes"]);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("10 seconds");
      const built = yield* Fiber.join(build);

      expect(fake.sandboxCreates).toEqual([
        {
          noEnv: true,
          setupScript: "install the runner",
          ttlSeconds: 7200,
          type: "small",
        },
      ]);
      expect(fake.sandboxReads).toBe(3);
      expect(fake.calls).toEqual([
        "POST /sandboxes",
        "POST /named-snapshots",
        `DELETE /sandboxes/${built.sourceSandboxId}`,
      ]);
      expect(fake.snapshots.get("signalbox-runner")?.sourceSandboxId).toBe(built.sourceSandboxId);
      expect(fake.sandboxes.size).toBe(0);
    }),
  );

  test.provider("does not save after a setup script fails and still deletes the builder", (stack) =>
    Effect.gen(function* () {
      fake.setupStatuses.push("failed");
      fake.setupError = "exit status 1";

      const result = yield* stack.deploy(image({ setupScript: "exit 1" })).pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      expect(fake.sandboxReads).toBe(1);
      expect(fake.calls).toEqual(["POST /sandboxes", `DELETE /sandboxes/${fake.lastSandboxId}`]);
      expect(fake.snapshots.size).toBe(0);
      expect(fake.sandboxes.size).toBe(0);
    }),
  );

  test.provider("fails a still-pending setup at the polling limit without saving", (stack) =>
    Effect.gen(function* () {
      fake.setupStatuses.push("pending");
      const firstRead = yield* Deferred.make<void>();
      fake.firstSandboxRead = firstRead;
      const build = yield* Effect.forkChild(
        stack.deploy(image({ setupScript: "wait forever" })).pipe(Effect.result),
      );

      yield* Deferred.await(firstRead);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("35 minutes");
      const result = yield* Fiber.join(build);

      expect(Result.isFailure(result)).toBe(true);
      expect(fake.sandboxReads).toBeGreaterThan(1);
      expect(fake.calls).toEqual(["POST /sandboxes", `DELETE /sandboxes/${fake.lastSandboxId}`]);
      expect(fake.snapshots.size).toBe(0);
      expect(fake.sandboxes.size).toBe(0);
    }),
  );

  test.provider("accepts a null setup status when no script was requested", (stack) =>
    Effect.gen(function* () {
      const built = yield* stack.deploy(image({ from: "signalbox-base" }));

      expect(fake.sandboxCreates).toEqual([
        { from: "signalbox-base", noEnv: true, ttlSeconds: 7200, type: "small" },
      ]);
      expect(fake.sandboxReads).toBe(1);
      expect(fake.calls).toEqual([
        "POST /sandboxes",
        "POST /named-snapshots",
        `DELETE /sandboxes/${built.sourceSandboxId}`,
      ]);
    }),
  );
});
