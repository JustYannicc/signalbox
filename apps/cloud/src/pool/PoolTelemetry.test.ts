import { describe, expect, it } from "@effect/vitest";
import { RunId } from "@t3tools/contracts";
import { POOL_LINK_PATH } from "@t3tools/contracts/accountHub";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import { isManagementRequest, unknownRelease } from "./CliProxyApiRuntime.ts";
import { observePoolCallEffect, type PoolCallEvent } from "./PoolTelemetry.ts";
import { makeFakeCliProxyApi, makeMemoryPoolObject } from "./testing.ts";

const actor = { userId: "user-1" };
const thread = "thread-1";
const trace = { runId: RunId.make("run-1"), traceId: "4bf92f3577b34da6a3ce929d0e0e4736" };
const canary = "private-account-and-prompt-canary";
const headers = {
  "x-cpa-version": "v8.0.31",
  "x-cpa-commit": "0123456789abcdef0123456789abcdef01234567",
  "x-cpa-build-date": "2026-10-16T12:34:56Z",
};
const known = {
  source: "management-headers",
  version: "8.0.31",
  commit: headers["x-cpa-commit"],
  buildDate: headers["x-cpa-build-date"],
};

const modelRequest = () =>
  new Request(`https://pool.test/v1/messages?account=${canary}`, {
    method: "POST",
    headers: { authorization: `Bearer ${canary}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-model", messages: [{ content: canary }] }),
  });

describe("pool release attribution", () => {
  it.effect("measures Effect-backed calls with the active clock", () => {
    const events: Array<PoolCallEvent> = [];
    return Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const pending = yield* Effect.forkChild(
        observePoolCallEffect({
          request: new Request("https://pool.test/v1/messages"),
          baseUrl: "https://pool.test",
          backing: "managed",
          release: () => unknownRelease,
          submit: (event) => events.push(event),
          send: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              yield* Effect.sleep(Duration.millis(37));
              return new Response("ok");
            }),
        }),
      );
      yield* Deferred.await(entered);
      yield* TestClock.adjust(37);
      expect((yield* Fiber.join(pending)).status).toBe(200);
      expect(events[0]?.poolCall.headersMs).toBe(37);
    });
  });

  it("keeps link affinity working without exporting it as verified thread correlation", async () => {
    const events: Array<PoolCallEvent> = [];
    const pool = makeMemoryPoolObject(undefined, (event) => events.push(event));
    try {
      await pool.api.create(actor, { name: "Work", personal: true });
      const link = await pool.api.openLink(actor);
      if (link._tag !== "ok") throw new Error("Could not open the test link.");
      const moved = await pool.api.linkFetch(
        link.value,
        new Request(`https://pool.test${POOL_LINK_PATH}/accounts`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            accounts: ["first", "second"].map((name) => ({
              name: `${name}.json`,
              content: JSON.stringify({ type: "claude", email: `${name}@example.test` }),
            })),
          }),
        }),
      );
      expect(moved.status).toBe(200);
      const send = () =>
        pool.api.linkFetch(
          link.value,
          new Request(`https://pool.test${POOL_LINK_PATH}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-signalbox-thread": canary },
            body: JSON.stringify({ model: "claude-opus-5-5" }),
          }),
        );
      const first = await send();
      const second = await send();
      expect([first.status, second.status]).toEqual([200, 200]);
      expect(first.headers.get("x-fake-account")).not.toBeNull();
      expect(second.headers.get("x-fake-account")).toBe(first.headers.get("x-fake-account"));
      expect(events.at(-1)?.person).toEqual({ id: actor.userId });
      expect(events.at(-1)?.thread).toBeUndefined();
      expect(events.at(-1)?.turn).toBeUndefined();
      expect(JSON.stringify(events)).not.toContain(canary);
    } finally {
      await pool.runtime.dispose();
    }
  });

  it("attributes header latency and failures to the running release without probing model calls", async () => {
    const events: Array<PoolCallEvent> = [];
    const pool = makeMemoryPoolObject(undefined, (event) => events.push(event));
    const paths: Array<string> = [];
    const serve = pool.cliProxyApi.serve;
    let failure: "http" | "transport" | null = null;
    pool.cliProxyApi.serve = async (request) => {
      paths.push(new URL(request.url).pathname);
      if (!isManagementRequest(request) && failure === "transport") throw new Error(canary);
      const response =
        failure === "http" && !isManagementRequest(request)
          ? new Response(canary, { status: 503 })
          : await serve(request);
      // A model reply with these same headers must not establish release identity.
      for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
      return response;
    };
    try {
      await pool.api.create(actor, { name: canary, personal: true });
      const first = await pool.api.forwardModel(actor, "/v1/messages", modelRequest(), thread);
      expect(first._tag).toBe("forwarded");
      expect(paths).toEqual(["/v1/messages"]);
      expect(events.at(-1)).toMatchObject({ cliProxyApi: { source: "unknown", version: null } });
      failure = "transport";
      expect((await pool.api.forwardModel(actor, "/v1/messages", modelRequest()))._tag).toBe(
        "failed",
      );
      expect(events.at(-1)).toMatchObject({
        status: 502,
        cliProxyApi: { source: "unknown", version: null },
      });

      failure = null;
      await pool.api.startLogin(actor, "claude");
      expect(events.at(-1)).toMatchObject({ cliProxyApi: known, poolCall: { kind: "management" } });
      paths.length = 0;
      failure = "http";
      const http = await pool.api.forwardModel(
        actor,
        "/v1/messages",
        modelRequest(),
        thread,
        trace,
      );
      expect(http._tag === "forwarded" && http.response.status).toBe(503);
      expect(events.at(-1)).toMatchObject({
        action: "pool.call",
        person: { id: actor.userId },
        thread: { id: thread },
        turn: { id: trace.runId, traceId: trace.traceId },
        cliProxyApi: known,
        status: 503,
        poolCall: {
          backing: "managed",
          kind: "model",
          outcome: "http_error",
          headersMs: expect.any(Number),
        },
      });
      failure = "transport";
      const transport = await pool.api.forwardModel(actor, "/v1/messages", modelRequest(), thread);
      expect(transport._tag).toBe("failed");
      expect(events.at(-1)).toMatchObject({
        cliProxyApi: known,
        status: 502,
        poolCall: { headersMs: expect.any(Number), outcome: "transport_error" },
      });
      expect(paths).toEqual(["/v1/messages", "/v1/messages"]);
      expect(JSON.stringify(events)).not.toContain(canary);
    } finally {
      await pool.runtime.dispose();
    }
  });

  it("keeps external and linked model releases unknown through URL and credential changes", async () => {
    const events: Array<PoolCallEvent> = [];
    const external = makeFakeCliProxyApi();
    let version = "8.0.30";
    const pool = makeMemoryPoolObject(
      async (request) => {
        if (new URL(request.url).pathname === "/api/pool-link") {
          return Response.json(
            { name: canary, accounts: [] },
            { headers: { "x-cpa-version": version } },
          );
        }
        const response = await external.serve(request);
        response.headers.set("x-cpa-version", version);
        return response;
      },
      (event) => events.push(event),
    );
    const managedServe = pool.cliProxyApi.serve;
    pool.cliProxyApi.serve = async (request) => {
      const response = await managedServe(request);
      if (isManagementRequest(request)) response.headers.set("x-cpa-version", "8.0.31");
      return response;
    };
    try {
      await pool.api.create(actor, { name: canary, personal: true });
      await pool.api.startLogin(actor, "claude");
      expect(events.at(-1)?.cliProxyApi.version).toBe("8.0.31");
      for (const { url, managementKey } of [
        { url: "https://external.test", managementKey: "key-1" },
        { url: "https://external.test", managementKey: "key-2" },
        { url: "https://other.test", managementKey: "key-3" },
      ]) {
        const backing = await pool.api.setBacking(actor, {
          mode: "external",
          url,
          managementKey,
          clientKey: canary,
        });
        expect(backing._tag).toBe("ok");
        expect(events.some((event) => event.cliProxyApi.version === version)).toBe(true);
        version = "8.0.29";
        await pool.api.forwardModel(actor, "/v1/messages", modelRequest());
        expect(events.at(-1)).toMatchObject({
          cliProxyApi: { source: "unknown", version: null },
          poolCall: { backing: "external" },
        });
      }
      await pool.api.setBacking(actor, {
        mode: "external",
        url: "https://linked.test/api/pool-link",
        managementKey: canary,
        clientKey: canary,
      });
      await pool.api.forwardModel(actor, "/v1/messages", modelRequest());
      expect(events.at(-1)).toMatchObject({
        cliProxyApi: { source: "unknown", version: null },
        poolCall: { backing: "linked" },
      });
      await pool.api.setBacking(actor, { mode: "managed" });
      await pool.api.forwardModel(actor, "/v1/messages", modelRequest());
      expect(events.at(-1)).toMatchObject({
        cliProxyApi: { source: "unknown", version: null },
        poolCall: { backing: "managed" },
      });
      expect(JSON.stringify(events)).not.toContain(canary);
    } finally {
      await pool.runtime.dispose();
    }
  });

  it("records a refused management response's release without exposing its body or credentials", async () => {
    const events: Array<PoolCallEvent> = [];
    let metadata: Record<string, string> = headers;
    const pool = makeMemoryPoolObject(
      async () => new Response(canary, { status: 401, headers: metadata }),
      (event) => events.push(event),
    );
    try {
      await pool.api.create(actor, { name: canary, personal: true });
      const connect = () =>
        pool.api.setBacking(actor, {
          mode: "external",
          url: `https://pool.test/${canary}`,
          managementKey: canary,
          clientKey: canary,
        });
      expect((await connect())._tag).toBe("rejected");
      expect(events.at(-1)).toMatchObject({
        status: 401,
        cliProxyApi: known,
        poolCall: { kind: "management", outcome: "http_error" },
      });
      for (const invalid of [
        {},
        { "x-cpa-version": canary },
        { "x-cpa-version": `1.0.0-${"x".repeat(65)}` },
      ]) {
        metadata = invalid;
        await connect();
        expect(events.at(-1)).toMatchObject({ cliProxyApi: { source: "unknown", version: null } });
      }
      metadata = { "x-cpa-version": "8.0.31", "x-cpa-commit": canary, "x-cpa-build-date": canary };
      await connect();
      expect(events.at(-1)?.cliProxyApi).toEqual({
        source: "management-headers",
        version: "8.0.31",
        commit: null,
        buildDate: null,
      });
      expect(JSON.stringify(events)).not.toContain(canary);
    } finally {
      await pool.runtime.dispose();
    }
  });
});
