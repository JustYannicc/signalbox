import { secretPlaceholder, type SecretValue } from "@signalbox/runner-protocol/SecretScrubber";
import { RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { ModelGatewayRecord } from "../modelGateway/modelGatewayRecord.ts";
import { makeModelAccess } from "./testing.ts";
import type {
  LocalModelAuthorization,
  ModelAuthorization,
  ModelForwardReply,
  ModelPoolRoute,
  ModelRequest,
} from "./ModelProtocol.ts";

const TOKEN = "sbm1.dGhyZWFkLWE.live";
const threadId = ThreadId.make("thread-a");
const runId = RunId.make("run-1");
const pool: ModelPoolRoute = { objectName: "user_1:personal", userId: "user_1" };
const request = () =>
  new Request("http://gateway.test/anthropic/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "claude", messages: [] }),
  });
const secret = (value: string): SecretValue => ({ name: "API_KEY", value });
const granted = (secrets: ReadonlyArray<SecretValue> = []): ModelAuthorization => ({
  _tag: "granted",
  runId,
  traceId: "trace-1",
  pool,
  secrets,
});
const forwarded = (response = new Response("ok")): ModelForwardReply => ({
  _tag: "forwarded",
  response,
  upstreamMs: 1,
});

const access = (overrides: Partial<Parameters<typeof makeModelAccess>[0]> = {}) => {
  const calls = {
    threads: [] as Array<string>,
    locals: [] as Array<string>,
    forwards: [] as Array<{
      pool: ModelPoolRoute;
      path: string;
      request: Request;
      thread: string | undefined;
    }>,
    threadRecords: [] as Array<{ threadId: string; record: ModelGatewayRecord }>,
    localsRecords: [] as Array<{
      userId: string;
      keyId: string;
      usage: ModelGatewayRecord["usage"];
    }>,
  };
  const authority: Parameters<typeof makeModelAccess>[0] = {
    authorizeThread: async (id, token, _provider) => {
      calls.threads.push(`${id}:${token}`);
      return granted();
    },
    authorizeLocal: async (token): Promise<LocalModelAuthorization> => {
      calls.locals.push(token);
      return { _tag: "denied", reason: "denied" };
    },
    forward: async (route, path, req, thread) => {
      calls.forwards.push({ pool: route, path, request: req, thread });
      return forwarded();
    },
    recordThread: async (id, record) => {
      calls.threadRecords.push({ threadId: id, record });
    },
    recordLocal: async ({ userId, keyId }, usage) => {
      calls.localsRecords.push({ userId, keyId, usage });
    },
    ...overrides,
  };
  return Effect.map(makeModelAccess(authority), (service) => ({ service, calls }));
};

const serve = (service: Effect.Success<ReturnType<typeof makeModelAccess>>, input: ModelRequest) =>
  Effect.promise(() => service.serve(input));

describe("ModelAccess", () => {
  it.effect("rejects malformed tokens before consulting authorities or pools", () =>
    Effect.gen(function* () {
      const { service, calls } = yield* access();
      expect(
        yield* serve(service, {
          token: "bad",
          provider: "anthropic",
          path: "/v1/messages",
          request: request(),
        }),
      ).toMatchObject({ _tag: "denied", reason: "Not a model token." });
      expect(calls.threads).toEqual([]);
      expect(calls.locals).toEqual([]);
      expect(calls.forwards).toEqual([]);
    }),
  );

  it.effect("preserves thread denial and never forwards it", () =>
    Effect.gen(function* () {
      const { service, calls } = yield* access({
        authorizeThread: async () => ({ _tag: "denied", reason: "turn stopped" }),
      });
      expect(
        yield* serve(service, {
          token: TOKEN,
          provider: "anthropic",
          path: "/v1/messages",
          request: request(),
        }),
      ).toMatchObject({ _tag: "denied", reason: "turn stopped" });
      expect(calls.forwards).toEqual([]);
    }),
  );

  it.effect("returns an unregistered-secret denial as granted without forwarding", () =>
    Effect.gen(function* () {
      const { service, calls } = yield* access({
        authorizeThread: async () => ({
          _tag: "unregistered",
          runId,
          traceId: "trace-1",
          reason: "register first",
        }),
      });
      expect(
        yield* serve(service, {
          token: TOKEN,
          provider: "anthropic",
          path: "/v1/messages",
          request: request(),
        }),
      ).toMatchObject({ _tag: "granted", reply: { _tag: "denied", reason: "register first" } });
      expect(calls.forwards).toEqual([]);
    }),
  );

  it.effect("scrubs registered secrets and forwards with the token's thread affinity", () =>
    Effect.gen(function* () {
      const raw = "private-value";
      const body = new Request("http://gateway.test/anthropic/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ output: raw }),
      });
      const { service, calls } = yield* access({
        authorizeThread: async () => granted([secret(raw)]),
      });
      const reply = yield* serve(service, {
        token: TOKEN,
        provider: "anthropic",
        path: "/v1/messages?stream=true",
        request: body,
      });
      expect(reply).toMatchObject({ _tag: "granted", reply: { _tag: "forwarded" } });
      expect(calls.forwards).toHaveLength(1);
      expect(calls.forwards[0]).toMatchObject({
        pool,
        path: "/v1/messages?stream=true",
        thread: "thread-a",
      });
      const sent = yield* Effect.promise(() => calls.forwards[0]!.request.text());
      expect(sent).toContain(secretPlaceholder("API_KEY"));
      expect(sent).not.toContain(raw);
    }),
  );

  it.effect("preserves token affinity while the authority receives the decoded thread ID", () =>
    Effect.gen(function* () {
      const { service, calls } = yield* access();
      const token = "sbm1.IHRocmVhZC1hIA.live";
      yield* serve(service, {
        token,
        provider: "anthropic",
        path: "/v1/messages",
        request: request(),
      });
      expect(calls.threads).toEqual([`thread-a:${token}`]);
      expect(calls.forwards[0]?.thread).toBe(" thread-a ");
    }),
  );

  it.effect("asks for current authorization on every request", () =>
    Effect.gen(function* () {
      let count = 0;
      const { service, calls } = yield* access({
        authorizeThread: async () => {
          count += 1;
          return count === 1 ? { _tag: "denied", reason: "revoked" } : granted();
        },
      });
      const input = {
        token: TOKEN,
        provider: "anthropic" as const,
        path: "/v1/messages",
        request: request(),
      };
      expect(yield* serve(service, input)).toMatchObject({ _tag: "denied" });
      expect(yield* serve(service, input)).toMatchObject({
        _tag: "granted",
        reply: { _tag: "forwarded" },
      });
      expect(count).toBe(2);
      expect(calls.forwards).toHaveLength(1);
    }),
  );

  it.effect("uses local-key authorization and forwarding without a thread", () =>
    Effect.gen(function* () {
      const local: LocalModelAuthorization = { _tag: "granted", keyId: "key-1", pool };
      const { service, calls } = yield* access({ authorizeLocal: async () => local });
      const reply = yield* serve(service, {
        token: "sbk_signed-token",
        provider: "anthropic",
        path: "/v1/messages",
        request: request(),
      });
      expect(reply).toMatchObject({
        _tag: "granted-local",
        userId: pool.userId,
        keyId: "key-1",
        reply: { _tag: "forwarded" },
      });
      expect(calls.threads).toEqual([]);
      expect(calls.forwards[0]).toMatchObject({ pool, thread: undefined });
    }),
  );

  it.effect(
    "propagates authority rejection and converts forwarding rejection to a failed reply",
    () =>
      Effect.gen(function* () {
        const rejected = new Error("authority unavailable");
        const first = yield* access({
          authorizeThread: async () => {
            throw rejected;
          },
        });
        const outcome = yield* Effect.promise(() =>
          first.service
            .serve({
              token: TOKEN,
              provider: "anthropic",
              path: "/v1/messages",
              request: request(),
            })
            .then(
              (value) => ({ _tag: "resolved", value }) as const,
              (error: unknown) => ({ _tag: "rejected", error }) as const,
            ),
        );
        expect(outcome).toEqual({ _tag: "rejected", error: rejected });

        const second = yield* access({
          forward: async () => {
            throw new Error("pool down");
          },
        });
        expect(
          yield* serve(second.service, {
            token: TOKEN,
            provider: "anthropic",
            path: "/v1/messages",
            request: request(),
          }),
        ).toMatchObject({
          _tag: "granted",
          reply: { _tag: "failed", reason: "The pool could not be reached." },
        });
      }),
  );

  it.effect(
    "reports thread and local usage through their owners and drops invalid thread IDs",
    () =>
      Effect.gen(function* () {
        const { service, calls } = yield* access();
        const record = {
          provider: "anthropic",
          method: "POST",
          path: "/v1/messages",
          status: 200,
          threadId,
          runId,
          traceId: "trace-1",
          authMs: 1,
          upstreamHeadersMs: null,
          firstChunkMs: null,
          addedMs: null,
          totalMs: 2,
          model: "claude",
          usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0 },
        } satisfies ModelGatewayRecord;
        yield* Effect.promise(() => service.report(record));
        yield* Effect.promise(() => service.report({ ...record, threadId: "" }));
        yield* Effect.promise(() =>
          service.report({
            ...record,
            threadId: null,
            local: { userId: "user_1", keyId: "key-1" },
          }),
        );
        expect(calls.threadRecords).toEqual([{ threadId, record }]);
        expect(calls.localsRecords).toEqual([
          { userId: "user_1", keyId: "key-1", usage: record.usage },
        ]);
      }),
  );
});
