import * as NodeCrypto from "node:crypto";

import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { isoAt } from "./time.ts";
import { WorkflowEngine } from "./WorkflowEngine.ts";
import { acceptedRun, saveOk, webhookRequest, withEngine } from "./WorkflowEngine.testkit.ts";

const source = (name: string, trigger: string) =>
  `export const meta = { name: "${name}", triggers: [${trigger}] } as const;
export default workflow(async (w, input: any, trigger: any) => {
  return { input, trigger };
});`;

it.effect("starts one run per delivery, by sender key or relay id, with redacted headers", () =>
  withEngine(
    {},
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const automation = yield* saveOk(source("Hook", "{ webhook: true }"));
      const deliver = (init: Parameters<typeof webhookRequest>[1]) =>
        engine.receiveWebhook(webhookRequest(automation, { body: '{"a":1}', ...init }));

      const first = yield* acceptedRun(
        yield* deliver({
          headers: {
            "idempotency-key": "evt-1",
            "x-github-event": "push",
            authorization: "Bearer hunter2",
            "x-t3-relay-delivery": "proof",
          },
          query: "ref=main&token=abc",
          relayDeliveryId: "relay-1",
        }),
      );
      expect(first.duplicate).toBe(false);
      // The sender retried, and the relay redelivered a held copy: both are the first run.
      expect(yield* deliver({ headers: { "idempotency-key": "evt-1" } })).toMatchObject({
        deliveryId: first.runId,
        outcome: "duplicate",
      });
      expect(yield* deliver({ relayDeliveryId: "relay-1" })).toMatchObject({
        deliveryId: first.runId,
        outcome: "duplicate",
      });
      const other = yield* acceptedRun(yield* deliver({ relayDeliveryId: "relay-2" }));
      expect(other.runId).not.toBe(first.runId);

      yield* engine.drain;
      expect((yield* engine.getRun(first.runId)).output).toEqual({
        input: { a: 1 },
        trigger: {
          type: "webhook",
          method: "POST",
          // Upstream's redaction covers anything named like a credential, keys included.
          headers: {
            "idempotency-key": "[redacted]",
            "x-github-event": "push",
            authorization: "[redacted]",
          },
          query: { ref: "main", token: "[redacted]" },
          rawBody: '{"a":1}',
        },
      });

      const rotated = yield* engine.rotateWebhook(automation.id);
      expect(rotated.webhook?.path).not.toBe(automation.webhook?.path);
      expect(yield* engine.receiveWebhook(webhookRequest(automation))).toEqual({
        _tag: "not_found",
      });
      yield* acceptedRun(yield* engine.receiveWebhook(webhookRequest(rotated)));
    }),
  ),
);

it.effect("checks the signature with the stored secret, and logs what it turns away", () =>
  withEngine(
    {},
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const automation = yield* saveOk(
        source(
          "Signed",
          '{ webhook: { signature: { header: "X-Hub-Signature-256", encoding: "hex", prefix: "sha256=" } } }',
        ),
      );
      const body = '{"action":"opened"}';
      const signed = (secret: string) =>
        webhookRequest(automation, {
          body,
          headers: {
            "x-hub-signature-256": `sha256=${NodeCrypto.createHmac("sha256", secret).update(body).digest("hex")}`,
          },
        });
      // No secret yet: nothing can be verified.
      expect(yield* engine.receiveWebhook(signed("s3cret"))).toEqual({
        _tag: "rejected_signature",
      });
      const updated = yield* engine.setWebhookSecret({
        automationId: automation.id,
        secret: "s3cret",
      });
      expect(updated.webhook?.hasSecret).toBe(true);
      yield* acceptedRun(yield* engine.receiveWebhook(signed("s3cret")));
      expect(yield* engine.receiveWebhook(signed("wrong"))).toEqual({
        _tag: "rejected_signature",
      });

      const detail = yield* engine.get(automation.id);
      expect(detail.webhookRejections.map((rejection) => rejection.outcome)).toEqual([
        "rejected_signature",
        "rejected_signature",
      ]);
      const cleared = yield* engine.setWebhookSecret({ automationId: automation.id, secret: null });
      expect(cleared.webhook?.hasSecret).toBe(false);
      expect(yield* engine.receiveWebhook(signed("s3cret"))).toEqual({
        _tag: "rejected_signature",
      });
    }),
  ),
);

it.effect("refuses paused automations, floods and stale held requests", () =>
  withEngine(
    {},
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      yield* TestClock.adjust("1 hour");
      const stale = yield* saveOk(source("Stale", "{ webhook: { maxDeliveryAgeMinutes: 5 } }"));
      const now = Date.parse(stale.updatedAt);
      const held = (minutesAgo: number) =>
        webhookRequest(stale, {
          relayDeliveryId: `relay-${minutesAgo}`,
          receivedAt: isoAt(now - minutesAgo * 60_000),
        });
      expect(yield* engine.receiveWebhook(held(10))).toEqual({ _tag: "expired" });
      yield* acceptedRun(yield* engine.receiveWebhook(held(2)));

      const paused = yield* saveOk(source("Paused", "{ webhook: true }"));
      yield* engine.setEnabled(paused.id, false);
      for (let request = 0; request < 60; request++) {
        expect(yield* engine.receiveWebhook(webhookRequest(paused))).toEqual({
          _tag: "disabled",
        });
      }
      for (let request = 0; request < 3; request++) {
        expect(yield* engine.receiveWebhook(webhookRequest(paused))).toEqual({
          _tag: "rate_limited",
          outcome: "rate_limited",
        });
      }
      const rejections = (yield* engine.get(paused.id)).webhookRejections;
      // Only the first rejection of a flood is logged, and the log keeps the newest 20.
      expect(rejections).toHaveLength(20);
      expect(rejections[0]?.outcome).toBe("rate_limited");
      expect(rejections.filter((rejection) => rejection.outcome === "rate_limited")).toHaveLength(
        1,
      );

      yield* TestClock.adjust("1 minute");
      expect(yield* engine.receiveWebhook(webhookRequest(paused))).toEqual({ _tag: "disabled" });
    }),
  ),
);
