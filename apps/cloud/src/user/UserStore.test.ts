import { AuthStandardClientScopes } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { layerMemoryStore } from "../testing.ts";
import * as UserStore from "./UserStore.ts";

const MINUTE = 60_000;
const profile = { id: "user_1", email: "ada@example.com", firstName: "Ada" };

const newSession = (store: UserStore.UserStore["Service"], ttlMs = 30 * MINUTE) =>
  store.createSession({ method: "bearer-access-token", scopes: AuthStandardClientScopes, ttlMs });

describe("UserStore", () => {
  it.effect("keeps one profile per user, updated on every sign-in", () =>
    Effect.gen(function* () {
      const store = yield* UserStore.UserStore;
      expect(yield* store.profile).toBeNull();
      yield* store.recordSignIn(profile);
      yield* store.recordSignIn({ ...profile, firstName: "Ada L." });
      expect(yield* store.profile).toEqual({ ...profile, firstName: "Ada L." });
    }).pipe(Effect.provide(layerMemoryStore)),
  );

  it.effect("finds a session only while it is unrevoked and unexpired", () =>
    Effect.gen(function* () {
      const store = yield* UserStore.UserStore;
      const session = yield* newSession(store);
      expect(yield* store.findSession(session.sid)).toEqual(session);
      expect(yield* store.revokeSession(session.sid)).toBe(true);
      expect(yield* store.revokeSession(session.sid)).toBe(false);
      expect(yield* store.findSession(session.sid)).toBeNull();

      const shortLived = yield* newSession(store, MINUTE);
      yield* TestClock.adjust("1 minute");
      expect(yield* store.findSession(shortLived.sid)).toBeNull();
    }).pipe(Effect.provide(layerMemoryStore)),
  );

  it.effect("redeems a handoff once, for its challenge only, into a one-time credential", () =>
    Effect.gen(function* () {
      const store = yield* UserStore.UserStore;
      yield* store.recordSignIn(profile);
      const handoff = yield* store.issueGrant({
        kind: "handoff",
        challenge: "right",
        ttlMs: MINUTE,
      });
      const redeem = (challenge: string) =>
        store.redeemHandoff({ gid: handoff.gid, challenge, credentialTtlMs: MINUTE });

      expect((yield* redeem("wrong"))._tag).toBe("rejected");
      const redeemed = yield* redeem("right");
      if (redeemed._tag !== "redeemed") throw new Error("expected a redemption");
      expect(redeemed.profile).toEqual(profile);
      expect((yield* redeem("right"))._tag).toBe("expired");

      const exchange = (gid: string) =>
        store.exchangeCredential({
          gid,
          method: "bearer-access-token",
          scopes: AuthStandardClientScopes,
          ttlMs: MINUTE,
        });
      const session = yield* exchange(redeemed.credential.gid);
      expect(session && (yield* store.findSession(session.sid))).toEqual(session);
      expect(yield* exchange(redeemed.credential.gid)).toBeNull();
      // A handoff is not a credential.
      expect(yield* exchange(handoff.gid)).toBeNull();
    }).pipe(Effect.provide(layerMemoryStore)),
  );

  it.effect("burns a handoff after five wrong verifiers", () =>
    Effect.gen(function* () {
      const store = yield* UserStore.UserStore;
      yield* store.recordSignIn(profile);
      const handoff = yield* store.issueGrant({
        kind: "handoff",
        challenge: "right",
        ttlMs: MINUTE,
      });
      const redeem = (challenge: string) =>
        store.redeemHandoff({ gid: handoff.gid, challenge, credentialTtlMs: MINUTE });
      for (let attempt = 0; attempt < 5; attempt++) {
        expect((yield* redeem("wrong"))._tag).toBe("rejected");
      }
      expect((yield* redeem("right"))._tag).toBe("expired");
    }).pipe(Effect.provide(layerMemoryStore)),
  );

  it.effect("lets grants expire", () =>
    Effect.gen(function* () {
      const store = yield* UserStore.UserStore;
      yield* store.recordSignIn(profile);
      const credential = yield* store.issueGrant({ kind: "credential", ttlMs: MINUTE });
      const handoff = yield* store.issueGrant({
        kind: "handoff",
        challenge: "right",
        ttlMs: MINUTE,
      });
      yield* TestClock.adjust("1 minute");
      expect(
        yield* store.exchangeCredential({
          gid: credential.gid,
          method: "bearer-access-token",
          scopes: AuthStandardClientScopes,
          ttlMs: MINUTE,
        }),
      ).toBeNull();
      expect(
        (yield* store.redeemHandoff({
          gid: handoff.gid,
          challenge: "right",
          credentialTtlMs: MINUTE,
        }))._tag,
      ).toBe("expired");
    }).pipe(Effect.provide(layerMemoryStore)),
  );
});
