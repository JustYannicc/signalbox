import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as CloudAccounts from "../account/CloudAccounts.ts";
import * as CloudConfig from "../CloudConfig.ts";
import { NO_STORE_HEADERS } from "./credentials.ts";

/**
 * `POST /api/workos/webhook`: WorkOS's events, so someone added to or removed
 * from an organization gets or loses its context at once rather than at their
 * next sign-in. A membership event only names who changed; their memberships
 * are read from WorkOS again, so events arriving late or out of order can't
 * leave a stale answer. Signed with `T3CODE_WORKOS_WEBHOOK_SECRET`; without it
 * the route doesn't exist. A failure answers 500, which WorkOS retries.
 */

export const WORKOS_WEBHOOK_PATH = "/api/workos/webhook";

/** How far an event's signed time may be from now, as WorkOS's SDKs allow by default. */
const TOLERANCE_MS = 5 * 60 * 1000;

const Event = Schema.Struct({
  event: Schema.String,
  data: Schema.Struct({ user_id: Schema.optional(Schema.String) }),
});
const decodeEvent = Schema.decodeUnknownOption(Schema.fromJsonString(Event));

/**
 * Whether `header` (`t=<ms>,v1=<hex HMAC-SHA256 of "<t>.<body>">`) signs
 * `body` with `secret`, recently enough.
 */
export async function verifyWorkOSSignature(
  header: string,
  body: string,
  secret: string,
  now: number,
): Promise<boolean> {
  const parts = new Map(
    header.split(",").map((part) => {
      const [key = "", ...value] = part.trim().split("=");
      return [key, value.join("=")] as const;
    }),
  );
  const timestamp = Number(parts.get("t"));
  if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > TOLERANCE_MS) return false;
  const signature = Hex.decode(parts.get("v1") ?? "");
  if (signature._tag === "Failure") return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  // `verify` compares in constant time.
  return crypto.subtle.verify(
    "HMAC",
    key,
    new Uint8Array(signature.success),
    new TextEncoder().encode(`${parts.get("t")}.${body}`),
  );
}

const text = (body: string, status: number) =>
  HttpServerResponse.text(body, { status, headers: NO_STORE_HEADERS });

export const layer = HttpRouter.add(
  "POST",
  WORKOS_WEBHOOK_PATH,
  Effect.gen(function* () {
    const { workosWebhookSecret } = yield* CloudConfig.CloudConfig;
    if (workosWebhookSecret === undefined) return text("Not found", 404);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* request.text;
    const now = yield* Clock.currentTimeMillis;
    const signed = yield* Effect.promise(() =>
      verifyWorkOSSignature(
        request.headers["workos-signature"] ?? "",
        body,
        Redacted.value(workosWebhookSecret),
        now,
      ),
    );
    if (!signed) return text("Bad signature", 401);
    const event = decodeEvent(body);
    if (event._tag === "None") return text("Unreadable event", 400);
    const userId = event.value.data.user_id;
    if (event.value.event.startsWith("organization_membership.") && userId !== undefined) {
      const accounts = yield* CloudAccounts.CloudAccounts;
      yield* accounts.refreshContexts(userId);
    }
    return text("ok", 200);
  }).pipe(
    Effect.catch((cause) =>
      Effect.logError("WorkOS webhook failed", { cause }).pipe(
        Effect.as(text("Internal Server Error", 500)),
      ),
    ),
  ),
);
