import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as CloudTokens from "../auth/CloudTokens.ts";
import { makeModelAccess } from "../models/testing.ts";
import type {
  LocalModelAuthorization,
  ModelForwardReply,
  ModelPoolRoute,
} from "../models/ModelProtocol.ts";
import { layerConfig, makeMemoryCloud } from "../testing.ts";
import * as ResourceBindings from "../user/ResourceBindings.ts";
import * as UserPools from "../user/UserPools.ts";
import { MAX_KEYS, signLocalKey, verifyLocalKey } from "./LocalKeys.ts";

const userId = "user_1";
const layerTokens = CloudTokens.layer.pipe(Layer.provide(layerConfig()));
type VerifiedLocalKey = Effect.Success<ReturnType<typeof verifyLocalKey>>;

const created = (key: { readonly _tag: string; readonly secret?: string }) => {
  if (key._tag !== "created" || key.secret === undefined) throw new Error("no key created");
  return key.secret;
};

/**
 * ModelAccess serves a signed key through the injected verifier, owner, and pool.
 */
const makeGrants = (
  verifiedKeys: ReadonlyMap<string, VerifiedLocalKey>,
  authorize: (userId: string, secret: string) => LocalModelAuthorization,
) => {
  const asked: Array<string> = [];
  const forwarded: Array<{
    readonly objectName: string;
    readonly userId: string;
    readonly path: string;
  }> = [];
  return Effect.map(
    makeModelAccess({
      authorizeThread: async () => ({ _tag: "denied", reason: "a local key never asks a thread" }),
      authorizeLocal: async (token) => {
        const verified = verifiedKeys.get(token) ?? null;
        if (verified === null) return { _tag: "denied", reason: "Not a Signalbox key." };
        asked.push(verified.userId);
        return authorize(verified.userId, verified.secret);
      },
      forward: async (pool: ModelPoolRoute, path: string) => {
        forwarded.push({ objectName: pool.objectName, userId: pool.userId, path });
        return {
          _tag: "forwarded",
          response: new Response("ok"),
          upstreamMs: 1,
        } satisfies ModelForwardReply;
      },
      recordThread: async () => undefined,
      recordLocal: async () => undefined,
    }),
    (modelAccess) => ({
      serve: (token: string) =>
        Effect.promise(() =>
          modelAccess.serve({
            token,
            provider: "anthropic",
            path: "/v1/messages",
            request: new Request("http://gateway.test/anthropic/v1/messages", { method: "POST" }),
          }),
        ),
      asked,
      forwarded,
    }),
  );
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
      return Effect.gen(function* () {
        const token = yield* signLocalKey(userId, "live");
        const verified = yield* verifyLocalKey(token);
        const oldToken = yield* signLocalKey(userId, "old");
        const oldVerified = yield* verifyLocalKey(oldToken);
        const { serve, forwarded } = yield* makeGrants(
          new Map<string, VerifiedLocalKey>([
            [token, verified],
            [oldToken, oldVerified],
          ]),
          (name, secret) =>
            secret === "live"
              ? {
                  _tag: "granted",
                  keyId: "key-1",
                  pool: { objectName: `${name}:personal`, userId: name },
                }
              : { _tag: "denied", reason: "This Signalbox key was revoked." },
        );
        expect(yield* serve(token)).toMatchObject({
          _tag: "granted-local",
          userId,
          keyId: "key-1",
          reply: { _tag: "forwarded" },
        });
        expect(forwarded).toEqual([
          { objectName: `${userId}:personal`, userId, path: "/v1/messages" },
        ]);
        expect(yield* serve(oldToken)).toMatchObject({
          _tag: "denied",
          reason: "This Signalbox key was revoked.",
        });
        expect(forwarded).toHaveLength(1);
      }).pipe(Effect.provide(layerTokens));
    },
  );

  it.effect("refuses a key this cloud didn't sign without asking anyone", () => {
    return Effect.gen(function* () {
      const forged = "sbk_forged";
      const verified = yield* verifyLocalKey(forged);
      const grants = yield* makeGrants(new Map([[forged, verified]]), () => {
        throw new Error("an unsigned key never wakes a user's object");
      });
      expect(verified).toBeNull();
      expect(yield* grants.serve(forged)).toMatchObject({
        _tag: "denied",
        reason: "Not a Signalbox key.",
      });
      expect(grants.asked).toEqual([]);
      expect(grants.forwarded).toEqual([]);
    }).pipe(Effect.provide(layerTokens));
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
