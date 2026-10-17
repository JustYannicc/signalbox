import { describe, expect, it } from "@effect/vitest";
import { RunId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { ModelGatewayRecord } from "../modelGateway/modelGatewayRecord.ts";
import type { PoolObjectNamespace } from "../pool/PoolDirectory.ts";
import type { ThreadObjectNamespace } from "../thread/ThreadDirectory.ts";
import type { UserObjectNamespace } from "../user/UserDirectory.ts";
import { layerModelAccess } from "./cloudflare.ts";
import * as ModelAccess from "./ModelAccess.ts";
import type { LocalKeyVerifier, ModelAuthorization, ModelForwardReply } from "./ModelProtocol.ts";

const TOKEN = "sbm1.dGhyZWFkLWE.live";
const pool = { objectName: "pool-owner:work", userId: "requester" };
const runId = RunId.make("run-1");
const record = {
  provider: "anthropic",
  method: "POST",
  path: "/v1/messages",
  status: 200,
  threadId: "thread-a",
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

const fixture = (localWorkerd = false, verifyLocalKey: LocalKeyVerifier = async () => null) => {
  const lookups: Array<string> = [];
  const jurisdictions: Array<string> = [];
  const authorizations: Array<{ name: string; token: string; provider: string }> = [];
  const localAuthorizations: Array<{ name: string; secret: string }> = [];
  const forwards: Array<{
    name: string;
    args: Parameters<ReturnType<PoolObjectNamespace["get"]>["forwardModel"]>;
  }> = [];
  const threadRecords: Array<{ name: string; record: ModelGatewayRecord }> = [];
  const localRecords: Array<{ name: string; keyId: string; usage: ModelGatewayRecord["usage"] }> =
    [];
  const response = new Response("streamed");
  const authorization: ModelAuthorization = {
    _tag: "granted",
    runId,
    traceId: "trace-1",
    pool,
    secrets: [],
  };

  // Workerd owns these opaque IDs and full RPC stubs; doubles supply only the methods used here.
  const byName = <A>(kind: string, get: (name: string) => A) => {
    const idFromName = (name: string) => {
      lookups.push(`${kind}:${name}`);
      return name as unknown as DurableObjectId;
    };
    return {
      idFromName,
      jurisdiction: (name: string) => {
        jurisdictions.push(`${kind}:${name}`);
        return { idFromName };
      },
      get: (id: DurableObjectId) => get(id as unknown as string),
    };
  };
  const threads = byName("threads", (name) => ({
    authorizeModel: async (token: string, provider: string) => {
      authorizations.push({ name, token, provider });
      return authorization;
    },
    recordModelRequest: async (record: ModelGatewayRecord) => {
      threadRecords.push({ name, record });
    },
  })) as unknown as ThreadObjectNamespace;
  const users = byName("users", (name) => ({
    authorizeLocalModel: async (secret: string) => {
      localAuthorizations.push({ name, secret });
      return { _tag: "granted", keyId: "key-1", pool };
    },
    recordLocalModelRequest: async (input: {
      keyId: string;
      usage: ModelGatewayRecord["usage"];
    }) => {
      localRecords.push({ name, ...input });
    },
  })) as unknown as UserObjectNamespace;
  const pools = byName("pools", (name) => ({
    forwardModel: async (
      ...args: Parameters<ReturnType<PoolObjectNamespace["get"]>["forwardModel"]>
    ) => {
      forwards.push({ name, args });
      return { _tag: "forwarded", response, upstreamMs: 1 } satisfies ModelForwardReply;
    },
  })) as unknown as PoolObjectNamespace;

  return Effect.map(
    ModelAccess.ModelAccess.pipe(
      Effect.provide(layerModelAccess({ threads, users, pools, verifyLocalKey }, { localWorkerd })),
    ),
    (service) => ({
      service,
      lookups,
      jurisdictions,
      authorizations,
      localAuthorizations,
      forwards,
      threadRecords,
      localRecords,
      response,
    }),
  );
};

describe("Cloudflare ModelAccess", () => {
  it.effect("rejects an unverified local key before looking up any object", () =>
    Effect.gen(function* () {
      const checked: Array<string> = [];
      const f = yield* fixture(false, async (token) => {
        checked.push(token);
        return null;
      });
      const reply = yield* Effect.promise(() =>
        f.service.serve({
          token: "sbk_forged",
          provider: "anthropic",
          path: "/v1/messages",
          request: new Request("http://gateway.test/v1/messages"),
        }),
      );
      expect(reply).toMatchObject({ _tag: "denied", reason: "Not a Signalbox key." });
      expect(checked).toEqual(["sbk_forged"]);
      expect(f.lookups).toEqual([]);
    }),
  );

  it.effect(
    "asks the verified key owner and forwards as the pool's requester without a thread",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(false, async () => ({
          userId: "requester",
          secret: "signed-secret",
        }));
        const request = new Request("http://gateway.test/v1/messages");
        const reply = yield* Effect.promise(() =>
          f.service.serve({
            token: "sbk_live",
            provider: "anthropic",
            path: "/v1/messages?stream=true",
            request,
          }),
        );
        expect(reply).toMatchObject({ _tag: "granted-local", userId: "requester", keyId: "key-1" });
        expect(f.localAuthorizations).toEqual([{ name: "requester", secret: "signed-secret" }]);
        expect(f.forwards).toEqual([
          {
            name: "pool-owner:work",
            args: [{ userId: "requester" }, "/v1/messages?stream=true", request, undefined],
          },
        ]);
        expect(f.lookups).toEqual(["users:requester", "pools:pool-owner:work"]);
        expect(f.jurisdictions).toEqual(["users:eu", "pools:eu"]);
      }),
  );

  it.effect(
    "routes thread authority and affinity while leaving local workerd unjurisdictioned",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(true, async () => {
          throw new Error("turn tokens never verify local keys");
        });
        const request = new Request("http://gateway.test/v1/messages");
        const reply = yield* Effect.promise(() =>
          f.service.serve({ token: TOKEN, provider: "anthropic", path: "/v1/messages", request }),
        );
        expect(f.authorizations).toEqual([
          { name: "thread-a", token: TOKEN, provider: "anthropic" },
        ]);
        expect(f.forwards).toEqual([
          {
            name: "pool-owner:work",
            args: [{ userId: "requester" }, "/v1/messages", request, "thread-a"],
          },
        ]);
        expect(
          reply._tag === "granted" && reply.reply._tag === "forwarded" && reply.reply.response,
        ).toBe(f.response);
        expect(f.jurisdictions).toEqual([]);
      }),
  );

  it.effect("reports usage to the named thread or local key owner", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* Effect.promise(() => f.service.report(record));
      yield* Effect.promise(() =>
        f.service.report({
          ...record,
          threadId: null,
          local: { userId: "key-owner", keyId: "key-2" },
        }),
      );
      expect(f.threadRecords).toEqual([{ name: "thread-a", record }]);
      expect(f.localRecords).toEqual([{ name: "key-owner", keyId: "key-2", usage: record.usage }]);
      expect(f.lookups).toEqual(["threads:thread-a", "users:key-owner"]);
      expect(f.jurisdictions).toEqual(["threads:eu", "users:eu"]);
    }),
  );
});
