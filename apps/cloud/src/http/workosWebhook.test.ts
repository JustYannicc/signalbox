import type { WorkOSMemberships } from "@signalbox/account/WorkOSTesting";
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpEffect from "effect/http/HttpEffect";
import { HttpRouter } from "effect/http";

import { CLOUD_TEST_ENV, layerAccounts } from "../testing.ts";
import * as UserDirectory from "../user/UserDirectory.ts";
import { verifyWorkOSSignature, WORKOS_WEBHOOK_PATH } from "./workosWebhook.ts";
import * as WorkOSWebhook from "./workosWebhook.ts";

const SECRET = "whsec_test";
const ENV = {
  ...CLOUD_TEST_ENV,
  T3CODE_WORKOS_API_KEY: "sk_test",
  T3CODE_WORKOS_WEBHOOK_SECRET: SECRET,
};

/** What WorkOS sends: `t=<ms>,v1=<hex HMAC-SHA256 of "<t>.<body>">`. */
const sign = async (body: string, at: number, secret = SECRET) => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${at}.${body}`));
  const hex = [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `t=${at}, v1=${hex}`;
};

const membershipEvent = (event: string, userId: string) =>
  JSON.stringify({
    id: "event_1",
    event,
    data: { object: "organization_membership", user_id: userId, organization_id: "org_acme" },
    created_at: "2026-10-08T12:00:00.000Z",
  });

describe("WorkOS webhook", () => {
  it.effect("accepts only a recent signature over the exact body", () =>
    Effect.promise(async () => {
      const body = membershipEvent("organization_membership.deleted", "user_ada");
      const now = 1_791_460_800_000;
      expect(await verifyWorkOSSignature(await sign(body, now), body, SECRET, now)).toBe(true);
      expect(await verifyWorkOSSignature(await sign(body, now), `${body} `, SECRET, now)).toBe(
        false,
      );
      expect(await verifyWorkOSSignature(await sign(body, now, "other"), body, SECRET, now)).toBe(
        false,
      );
      const stale = now - 10 * 60 * 1000;
      expect(await verifyWorkOSSignature(await sign(body, stale), body, SECRET, now)).toBe(false);
      expect(await verifyWorkOSSignature("", body, SECRET, now)).toBe(false);
    }),
  );

  // Live clock: the route checks the signature's time against the real one.
  it.live("a membership event re-reads the person's organizations at once", () => {
    // Mutable, so WorkOS's answer changes between events.
    const memberships: Record<string, WorkOSMemberships[string]> = {
      user_ada: [{ id: "org_acme", name: "Acme" }],
    };
    return Effect.gen(function* () {
      const context = yield* Layer.build(layerAccounts({}, ENV, memberships));
      const users = Context.get(context, UserDirectory.UserDirectory);
      // As the Worker serves it (`app.ts`): services come from the handler's context.
      const httpEffect = yield* HttpRouter.toHttpEffect(WorkOSWebhook.layer);
      const handler = HttpEffect.toWebHandler(httpEffect.pipe(Effect.provide(context)));
      const post = (body: string, signature?: string) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const header = signature ?? (yield* Effect.promise(() => sign(body, now)));
          return yield* Effect.promise(() =>
            handler(
              new Request(`https://cloud.test${WORKOS_WEBHOOK_PATH}`, {
                method: "POST",
                headers: { "workos-signature": header },
                body,
              }),
            ),
          );
        });
      const contexts = Effect.map(users.forUser("user_ada").contextIds(), (ids) => [...ids]);

      const added = membershipEvent("organization_membership.created", "user_ada");
      expect((yield* post(added, "t=1, v1=00")).status).toBe(401);
      expect(yield* contexts).toEqual(["personal"]);
      expect((yield* post(added)).status).toBe(200);
      expect(yield* contexts).toEqual(["personal", "org_acme"]);

      memberships.user_ada = [];
      expect(
        (yield* post(membershipEvent("organization_membership.deleted", "user_ada"))).status,
      ).toBe(200);
      expect(yield* contexts).toEqual(["personal"]);
      // Other events change nothing.
      memberships.user_ada = [{ id: "org_acme", name: "Acme" }];
      expect((yield* post(membershipEvent("user.updated", "user_ada"))).status).toBe(200);
      expect(yield* contexts).toEqual(["personal"]);
    }).pipe(Effect.scoped);
  });
});
