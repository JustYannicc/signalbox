import { ScheduledTaskWebhookDeliveryId, type WorkflowWebhookOptions } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as Metrics from "../observability/Metrics.ts";
import type {
  WebhookDeliveryOutcome,
  WebhookTriggerRequest,
  WebhookTriggerResult,
} from "../scheduledTasks/ScheduledTaskService.ts";
import { redactHeaders, redactQuery } from "../scheduledTasks/webhookTemplate.ts";
import {
  constantTimeEquals,
  verifyWebhookSignature,
} from "../scheduledTasks/webhookVerification.ts";
import { automationTriggers } from "./columns.ts";
import type { LaunchRun } from "./engineTypes.ts";
import { automationError } from "./errors.ts";
import { jsonOrText } from "./json.ts";
import { isoAt, nowIso } from "./time.ts";
import type { WebhookRejectionRow, WorkflowStore } from "./WorkflowStore.ts";

/**
 * Automation webhooks, received through upstream's `/api/hooks/:hookId/:token`
 * route as a `WebhookReceiver`: the hook id is the automation id. The route
 * caps the body and verifies relay deliveries; this checks the token, rate,
 * pause, signature and age, then starts the run. Turned-away requests are
 * logged; accepted ones are runs.
 */

/** Automation ids are `automation_<uuid>`; scheduled task ids never start this way. */
export const AUTOMATION_HOOK_PREFIX = "automation_";
/** Requests with a valid token per automation per minute, as upstream allows a task. */
const RATE_LIMIT_PER_MINUTE = 60;
const secretName = (automationId: string) => `automation-webhook-secret-${automationId}`;

/** The trigger's options, or null without a webhook trigger. `{ webhook: true }` has none. */
const webhookOptions = (
  row: Parameters<typeof automationTriggers>[0],
): WorkflowWebhookOptions | null => {
  for (const trigger of automationTriggers(row)) {
    if ("webhook" in trigger) return trigger.webhook === true ? {} : trigger.webhook;
  }
  return null;
};

/** The run's input: the body parsed as JSON or a form when it is one, else its text; null when empty. */
const bodyInput = (request: WebhookTriggerRequest): unknown => {
  if (request.bodyText === "") return null;
  if ((request.headers["content-type"] ?? "").includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(request.bodyText));
  }
  return jsonOrText(request.bodyText);
};

/** Headers as the run sees them: credentials redacted, the relay's own headers dropped. */
const runHeaders = (headers: Readonly<Record<string, string>>) =>
  redactHeaders(
    Object.fromEntries(Object.entries(headers).filter(([name]) => !name.startsWith("x-t3-"))),
  );

interface RateWindow {
  readonly accepted: ReadonlyArray<number>;
  /** Whether a rejection was already logged in this window, so a flood logs once. */
  readonly rejectedLogged: boolean;
}

export const makeWebhooks = (deps: {
  readonly store: WorkflowStore;
  readonly launchRun: LaunchRun;
}) =>
  Effect.gen(function* () {
    const { store, launchRun } = deps;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const windows = yield* Ref.make<ReadonlyMap<string, RateWindow>>(new Map());

    /** Sliding one-minute window over requests with a valid token, like upstream's per task. */
    const takeRateSlot = (automationId: string, nowMs: number) =>
      Ref.modify(
        windows,
        (current): readonly ["allowed" | "first" | "again", ReadonlyMap<string, RateWindow>] => {
          const window = current.get(automationId);
          const recent = (window?.accepted ?? []).filter((at) => nowMs - at < 60_000);
          if (recent.length >= RATE_LIMIT_PER_MINUTE) {
            return [
              window?.rejectedLogged === true ? "again" : "first",
              new Map(current).set(automationId, { accepted: recent, rejectedLogged: true }),
            ];
          }
          return [
            "allowed",
            new Map(current).set(automationId, {
              accepted: [...recent, nowMs],
              rejectedLogged: false,
            }),
          ];
        },
      );

    const readSecret = (automationId: string) =>
      secrets.get(secretName(automationId)).pipe(
        Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes))),
        Effect.mapError((cause) =>
          automationError("Couldn't read the webhook signing secret.", { cause }),
        ),
      );

    const receive = Effect.fn("automations.receiveWebhook")(function* (
      request: WebhookTriggerRequest,
    ) {
      const source = request.relayDeliveryId === undefined ? "direct" : "relay";
      const observe = <A extends WebhookTriggerResult>(
        outcome: WebhookDeliveryOutcome,
        result: A,
      ) =>
        Metrics.increment(Metrics.webhookDeliveriesTotal, { outcome, source }).pipe(
          Effect.andThen(Effect.annotateCurrentSpan({ "automation.webhook.outcome": outcome })),
          Effect.as(result),
        );
      const automation = yield* store.getAutomation(request.hookId);
      const options =
        automation === undefined || automation.version === 0 ? null : webhookOptions(automation);
      // A wrong token looks like an unknown hook, so the URL doesn't reveal which exist.
      if (
        automation === undefined ||
        options === null ||
        !constantTimeEquals(request.token, automation.webhook_token)
      ) {
        return yield* observe("not_found", { _tag: "not_found" as const });
      }
      const automationId = automation.automation_id;
      yield* Effect.annotateCurrentSpan({ "automation.id": automationId });
      const now = yield* DateTime.now;
      // The relay's receive time is only ever earlier than now, or a forged one could dodge the max age.
      const relayed =
        request.receivedAt === undefined ? Number.NaN : Date.parse(request.receivedAt);
      const receivedMs = Number.isFinite(relayed)
        ? Math.min(relayed, now.epochMilliseconds)
        : now.epochMilliseconds;
      const reject = <A extends WebhookTriggerResult>(
        outcome: WebhookRejectionRow["outcome"],
        result: A,
        log = true,
      ) =>
        (log
          ? store.recordWebhookRejection({
              automation_id: automationId,
              received_at: isoAt(receivedMs),
              method: request.method,
              outcome,
              body_bytes: request.body.byteLength,
              relayed: request.relayDeliveryId === undefined ? 0 : 1,
            })
          : Effect.void
        ).pipe(Effect.andThen(observe(outcome, result)));

      const slot = yield* takeRateSlot(automationId, now.epochMilliseconds);
      if (slot !== "allowed") {
        // 429 makes the relay hold the request and try again later.
        return yield* reject(
          "rate_limited",
          { _tag: "rate_limited" as const, outcome: "rate_limited" as const },
          slot === "first",
        );
      }
      if (automation.enabled !== 1) return yield* reject("disabled", { _tag: "disabled" as const });
      if (options.signature !== undefined) {
        const secret = yield* readSecret(automationId);
        const verified =
          Option.isSome(secret) &&
          verifyWebhookSignature({
            signature: {
              header: options.signature.header,
              encoding: options.signature.encoding,
              prefix: options.signature.prefix ?? "",
            },
            secret: secret.value,
            headers: request.headers,
            body: request.body,
          });
        if (!verified) {
          return yield* reject("rejected_signature", { _tag: "rejected_signature" as const });
        }
      }
      if (
        options.maxDeliveryAgeMinutes !== undefined &&
        now.epochMilliseconds - receivedMs > options.maxDeliveryAgeMinutes * 60_000
      ) {
        return yield* reject("expired", { _tag: "expired" as const });
      }

      // A sender's retry and the relay's redelivery of a held request start one run.
      const requestKey = request.headers["idempotency-key"] ?? request.headers["x-request-id"];
      const keys = [
        ...(requestKey ? [requestKey] : []),
        ...(request.relayDeliveryId ? [`relay:${request.relayDeliveryId}`] : []),
      ];
      const query = Object.fromEntries(new URLSearchParams(redactQuery(request.query)));
      // From the claim to the queued replay nothing may interrupt, or a hung-up
      // relay request could leave a claimed run that never replays.
      const started = yield* Effect.uninterruptible(
        launchRun({
          automation,
          input: bodyInput(request),
          trigger: "webhook",
          webhook: {
            method: request.method,
            headers: runHeaders(request.headers),
            query,
            rawBody: request.bodyText,
          },
          ...(keys.length > 0
            ? {
                claim: (runId: string) =>
                  store.claimRequestKeys({ automationId, keys, runId, now }),
              }
            : {}),
        }),
      );
      return yield* observe(started.duplicate ? "duplicate" : "accepted", {
        _tag: "accepted" as const,
        // The run is the delivery: senders get its id back.
        deliveryId: ScheduledTaskWebhookDeliveryId.make(started.run.id),
        outcome: started.duplicate ? ("duplicate" as const) : ("accepted" as const),
      });
    });

    /** Stores or clears (null) the signing secret, write-only, and flags that one is set. */
    const setSecret = (automationId: string, secret: string | null) =>
      Effect.gen(function* () {
        yield* (
          secret === null
            ? secrets.remove(secretName(automationId))
            : secrets.set(secretName(automationId), new TextEncoder().encode(secret))
        ).pipe(
          Effect.mapError((cause) =>
            automationError("Couldn't store the webhook signing secret.", { cause }),
          ),
        );
        yield* store.setWebhookSecretSet(automationId, secret !== null, yield* nowIso);
      });

    /** Drops a deleted automation's secret. */
    const forget = (automationId: string) =>
      secrets
        .remove(secretName(automationId))
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Couldn't delete an automation's webhook secret", { cause }),
          ),
        );

    return { receive, setSecret, forget };
  });
