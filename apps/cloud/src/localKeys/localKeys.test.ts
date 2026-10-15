import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as CloudTokens from "../auth/CloudTokens.ts";
import type { ModelForwardReply, PoolObjectNamespace } from "../pool/PoolDirectory.ts";
import { layerConfig, makeMemoryCloud } from "../testing.ts";
import { serveModel } from "../thread/runner/modelGrants.ts";
import type { ThreadObjectNamespace } from "../thread/ThreadDirectory.ts";
import * as ResourceBindings from "../user/ResourceBindings.ts";
import type { UserObjectNamespace } from "../user/UserDirectory.ts";
import * as UserPools from "../user/UserPools.ts";
import { MAX_KEYS, signLocalKey, verifyLocalKey } from "./LocalKeys.ts";
import type { LocalModelAuthorization } from "./localModelAccess.ts";

const userId = "user_1";
const layerTokens = CloudTokens.layer.pipe(Layer.provide(layerConfig()));

const created = (key: { readonly _tag: string; readonly secret?: string }) => {
  if (key._tag !== "created" || key.secret === undefined) throw new Error("no key created");
  return key.secret;
};

/**
 * `serveModel` as the `ModelGrants` entrypoint runs it, with user objects that
 * answer `authorize` and a pool that records what it got.
 */
const makeGrants = (authorize: (userId: string, secret: string) => LocalModelAuthorization) => {
  const asked: Array<string> = [];
  const forwarded: Array<{
    readonly objectName: string;
    readonly userId: string;
    readonly path: string;
  }> = [];
  const byName = <A>(get: (name: string) => A) => ({
    idFromName: (name: string) => name as unknown as DurableObjectId,
    jurisdiction: () => ({ idFromName: (name: string) => name as unknown as DurableObjectId }),
    get: (id: DurableObjectId) => get(id as unknown as string),
  });
  const users = byName((name) => ({
    authorizeLocalModel: async (secret: string) => {
      asked.push(name);
      return authorize(name, secret);
    },
  })) as unknown as UserObjectNamespace;
  const pools = byName((objectName) => ({
    forwardModel: async (actor: { readonly userId: string }, path: string) => {
      forwarded.push({ objectName, userId: actor.userId, path });
      return {
        _tag: "forwarded",
        response: new Response("ok"),
        upstreamMs: 1,
      } satisfies ModelForwardReply;
    },
  })) as unknown as PoolObjectNamespace;
  const threads = byName(() => {
    throw new Error("a local key never asks a thread");
  }) as unknown as ThreadObjectNamespace;
  const serve = (
    token: string,
    verified: { readonly userId: string; readonly secret: string } | null,
  ) =>
    Effect.promise(() =>
      serveModel(
        {
          threads,
          users,
          pools,
          verifyLocalKey: async () => verified,
          token,
          provider: "anthropic",
          path: "/v1/messages",
          request: new Request("http://gateway.test/anthropic/v1/messages", { method: "POST" }),
        },
        { localWorkerd: true },
      ),
    );
  return { serve, asked, forwarded };
};

describe("local keys", () => {
  it.effect("are signed by this cloud and name their user", () =>
    Effect.gen(function* () {
      const token = yield* signLocalKey(userId, "secret");
      expect(token.startsWith("sbk_")).toBe(true);
      expect(yield* verifyLocalKey(token)).toEqual({ userId, secret: "secret" });
      expect(yield* verifyLocalKey(`${token.slice(0, -2)}xx`)).toBeNull();
      expect(yield* verifyLocalKey(`sbk_${btoa(userId)}.secret`)).toBeNull();
      // A connection link is signed the same way, but is no key.
      const link = yield* CloudTokens.CloudTokens.use((tokens) =>
        tokens.sign({
          _tag: "connection-link",
          u: userId,
          s: "secret",
          exp: Number.MAX_SAFE_INTEGER,
        }),
      );
      expect(yield* verifyLocalKey(`sbk_${link}`)).toBeNull();
    }).pipe(Effect.provide(layerTokens)),
  );

  it.effect("run on the pool the top level resolves to, until revoked", () => {
    const cloud = makeMemoryCloud();
    return Effect.gen(function* () {
      const user = cloud.userDirectory.forUser(userId);
      yield* user.recordSignIn({ id: userId, email: "a@b.c" });
      const secret = created(yield* user.createLocalKey("Mac"));
      const [key] = (yield* user.localKeys()).keys;

      expect(yield* user.authorizeLocalModel(secret)).toEqual({
        _tag: "granted",
        keyId: key!.id,
        pool: { objectName: `${userId}:personal`, userId },
      });
      expect(yield* user.authorizeLocalModel("not-a-secret")).toMatchObject({ _tag: "denied" });

      // The key follows the hierarchy: whatever pool sits at the top level serves it.
      const services = yield* Effect.all({
        pools: UserPools.UserPools,
        bindings: ResourceBindings.ResourceBindings,
      }).pipe(Effect.provide(cloud.userObject(userId)));
      const work = yield* services.pools.create({ userId }, { name: "Work" });
      yield* services.bindings.setPool({ _tag: "top" }, work.id);
      expect(yield* user.authorizeLocalModel(secret)).toMatchObject({
        pool: { objectName: `${userId}:${work.id}` },
      });

      // None on the chain is never a silent fallback.
      yield* services.bindings.setPool({ _tag: "top" }, null);
      expect(yield* user.authorizeLocalModel(secret)).toEqual({
        _tag: "denied",
        reason: "Your top level has no pool. Pick one for it in Signalbox.",
      });

      // Revoked, the very next request is refused.
      yield* services.bindings.setPool({ _tag: "top" }, work.id);
      yield* user.revokeLocalKey(key!.id);
      expect(yield* user.authorizeLocalModel(secret)).toMatchObject({
        _tag: "denied",
        reason: expect.stringContaining("revoked"),
      });
    });
  });

  it.effect(
    "reach the gateway's pool as the key's user, and only once their object grants it",
    () => {
      const grants = makeGrants((name, secret) =>
        secret === "live"
          ? {
              _tag: "granted",
              keyId: "key-1",
              pool: { objectName: `${name}:personal`, userId: name },
            }
          : { _tag: "denied", reason: "This Signalbox key was revoked." },
      );
      return Effect.gen(function* () {
        expect(yield* grants.serve("sbk_live", { userId, secret: "live" })).toMatchObject({
          _tag: "granted-local",
          userId,
          keyId: "key-1",
          reply: { _tag: "forwarded" },
        });
        expect(grants.forwarded).toEqual([
          { objectName: `${userId}:personal`, userId, path: "/v1/messages" },
        ]);
        expect(yield* grants.serve("sbk_old", { userId, secret: "old" })).toMatchObject({
          _tag: "denied",
          reason: "This Signalbox key was revoked.",
        });
        expect(grants.forwarded).toHaveLength(1);
      });
    },
  );

  it.effect("refuses a key this cloud didn't sign without asking anyone", () => {
    const grants = makeGrants(() => {
      throw new Error("an unsigned key never wakes a user's object");
    });
    return Effect.gen(function* () {
      expect(yield* grants.serve("sbk_forged", null)).toMatchObject({
        _tag: "denied",
        reason: "Not a Signalbox key.",
      });
      expect(grants.asked).toEqual([]);
      expect(grants.forwarded).toEqual([]);
    });
  });

  it.effect("count what each key used, and how many a user may hold", () => {
    const cloud = makeMemoryCloud();
    return Effect.gen(function* () {
      const user = cloud.userDirectory.forUser(userId);
      yield* user.recordSignIn({ id: userId, email: "a@b.c" });
      created(yield* user.createLocalKey("  "));
      const [key] = (yield* user.localKeys()).keys;
      expect(key).toMatchObject({ label: "Computer", lastUsedAt: null, requests: 0, tokens: 0 });

      const usage = { input: 10, output: 5, cacheRead: 100, cacheWrite: 1 };
      yield* user.recordLocalModelRequest({ keyId: key!.id, usage });
      yield* user.recordLocalModelRequest({ keyId: key!.id, usage: null });
      expect(yield* user.localKeys()).toMatchObject({
        poolId: "personal",
        keys: [{ requests: 2, tokens: 116, lastUsedAt: expect.any(Number) }],
      });

      for (let index = 1; index < MAX_KEYS; index++) created(yield* user.createLocalKey("Mac"));
      expect(yield* user.createLocalKey("One too many")).toEqual({ _tag: "limit" });
    });
  });
});
