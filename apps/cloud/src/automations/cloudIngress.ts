import { AutomationError, type WorkflowWebhookOptions } from "@t3tools/contracts";
import { automationTriggers } from "@signalbox/automations/columns";
import { AutomationIngress, type IngressDependencies } from "@signalbox/automations/host";
import { nowIso } from "@signalbox/automations/time";
import { hookEndpoint } from "@signalbox/automations/views";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { UserStore } from "../user/UserStore.ts";
import { HookStore } from "./hookStore.ts";
import {
  deliveryKey,
  hookInput,
  MAX_HOOK_BYTES,
  publicHeaders,
  publicQuery,
  sameToken,
  verifySignature,
  type HookAnswer,
  type HookRequest,
} from "./webhookRequest.ts";

/** Alchemy supplies the deployment's origin. Local hosts may return relative links. */
export class HookOrigin extends Context.Reference<string>("@signalbox/cloud/HookOrigin", {
  defaultValue: () => "",
}) {}

export class CloudHooks extends Context.Service<
  CloudHooks,
  {
    readonly receive: (request: HookRequest) => Effect.Effect<HookAnswer, AutomationError>;
    readonly deliver: (
      kind: "automation" | "callback",
      payload: string,
      id: string,
    ) => Effect.Effect<void, AutomationError>;
  }
>()("@signalbox/cloud/automations/cloudIngress/CloudHooks") {}

const Delivery = Schema.Struct({
  hookId: Schema.String,
  input: Schema.Unknown,
  at: Schema.String,
  method: Schema.String,
  headers: Schema.Record(Schema.String, Schema.String),
  query: Schema.Record(Schema.String, Schema.String),
  rawBody: Schema.String,
});
type Delivery = typeof Delivery.Type;
const decodeDelivery = Schema.decodeUnknownSync(Schema.fromJsonString(Delivery));

/** The engine constructs its ingress once; HTTP receives only after that construction finishes. */
export const layer = Layer.effectContext(
  Effect.gen(function* () {
    const inbox = yield* HookStore;
    const users = yield* UserStore;
    const origin = yield* HookOrigin;
    const built = yield* Deferred.make<IngressDependencies>();
    const baseUrl = users.profile.pipe(
      Effect.map((profile) =>
        profile === null ? null : `${origin}/api/hooks/${encodeURIComponent(profile.id)}`,
      ),
      Effect.orDie,
    );

    const receive = Effect.fn("CloudHooks.receive")(function* (
      request: HookRequest,
    ): Effect.fn.Return<HookAnswer, AutomationError> {
      if (request.body.byteLength > MAX_HOOK_BYTES) return { status: 413 };
      const { store } = yield* Deferred.await(built);
      const callback = request.hookId.startsWith("callback_")
        ? yield* store.getCallback(request.hookId)
        : undefined;
      const run = callback ? yield* store.getRun(callback.run_id) : undefined;
      const automation = yield* store.getAutomation(run?.automation_id ?? request.hookId);
      const trigger =
        automation && automationTriggers(automation).find((entry) => "webhook" in entry);
      const options: WorkflowWebhookOptions | null =
        trigger && "webhook" in trigger ? (trigger.webhook === true ? {} : trigger.webhook) : null;
      if (
        !automation ||
        (callback ? run?.status !== "running" : options === null || automation.version === 0)
      )
        return { status: 404 };
      yield* Effect.annotateCurrentSpan({
        "folder.id": automation.project_id,
        "automation.id": automation.automation_id,
      });
      if (
        !(yield* Effect.promise(() =>
          sameToken(request.token, callback?.token ?? automation.webhook_token),
        ))
      )
        return { status: 404 };
      const reject = (outcome: "disabled" | "rate_limited" | "rejected_signature") =>
        nowIso.pipe(
          Effect.flatMap((received_at) =>
            store.recordWebhookRejection({
              automation_id: automation.automation_id,
              received_at,
              method: request.method,
              outcome,
              body_bytes: request.body.byteLength,
              relayed: 0,
            }),
          ),
        );
      if (automation.enabled !== 1) {
        yield* reject("disabled");
        return { status: 409 };
      }
      if (!callback && options?.signature) {
        const signature = options.signature;
        const secret = yield* inbox.secret(automation.automation_id);
        const verified =
          secret !== null &&
          (yield* Effect.promise(() => verifySignature(signature, secret, request)));
        if (!verified) {
          yield* reject("rejected_signature");
          return { status: 401 };
        }
      }
      const result = yield* inbox.enqueue({
        kind: callback ? "callback" : "automation",
        target: request.hookId,
        key: deliveryKey(request.headers),
        maxPerMinute: 60,
        payload: {
          hookId: request.hookId,
          input: hookInput(request),
          at: yield* nowIso,
          method: request.method,
          headers: publicHeaders(request.headers),
          query: publicQuery(request.query),
          rawBody: new TextDecoder().decode(request.body),
        } satisfies Delivery,
      });
      if (result.status === 429) yield* reject("rate_limited");
      return result;
    });

    const deliver: CloudHooks["Service"]["deliver"] = (kind, payload, id) =>
      Effect.gen(function* () {
        const { store, launchRun, deliverTo } = yield* Deferred.await(built);
        const delivery = decodeDelivery(payload);
        if (kind === "callback") {
          const link = yield* store.getCallback(delivery.hookId);
          const run = link ? yield* store.getRun(link.run_id) : undefined;
          const automation = run ? yield* store.getAutomation(run.automation_id) : undefined;
          if (!run || run.status !== "running" || !automation) return;
          yield* deliverTo(run.run_id, {
            event: "hook.called",
            id: `hook.called:${id}`,
            at: delivery.at,
            projectId: automation.project_id,
            hookId: delivery.hookId,
            body: delivery.input,
            method: delivery.method,
            headers: delivery.headers,
            query: delivery.query,
          });
          return;
        }
        const automation = yield* store.getAutomation(delivery.hookId);
        if (!automation || automation.enabled !== 1) return;
        const now = yield* DateTime.now;
        const trigger = automationTriggers(automation).find((entry) => "webhook" in entry);
        const maxAge =
          trigger && "webhook" in trigger && trigger.webhook !== true
            ? trigger.webhook.maxDeliveryAgeMinutes
            : undefined;
        if (
          maxAge !== undefined &&
          now.epochMilliseconds - Date.parse(delivery.at) > maxAge * 60_000
        ) {
          yield* store.recordWebhookRejection({
            automation_id: automation.automation_id,
            received_at: delivery.at,
            method: delivery.method,
            outcome: "expired",
            body_bytes: new TextEncoder().encode(delivery.rawBody).byteLength,
            relayed: 0,
          });
          return;
        }
        yield* launchRun({
          automation,
          input: delivery.input,
          trigger: "webhook",
          webhook: {
            method: delivery.method,
            headers: delivery.headers,
            query: delivery.query,
            rawBody: delivery.rawBody,
          },
          claim: (runId) =>
            store.claimRequestKeys({
              automationId: automation.automation_id,
              keys: [`cloud-hook:${id}`],
              runId,
              now,
            }),
        });
      });

    return Context.make(CloudHooks, { receive, deliver }).pipe(
      Context.add(AutomationIngress, {
        make: (deps) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(built, deps);
            return {
              hookBaseUrl: baseUrl,
              createCallback: (runId, chosenId) =>
                Effect.gen(function* () {
                  const hookId = chosenId ?? (yield* deps.newId("callback"));
                  const existing = yield* deps.store.getCallback(hookId);
                  if (existing?.run_id === runId)
                    return { hookId, ...hookEndpoint(hookId, existing.token, yield* baseUrl) };
                  const token = yield* deps.newId("token");
                  yield* deps.store.insertCallback({ hookId, runId, token, now: yield* nowIso });
                  return { hookId, ...hookEndpoint(hookId, token, yield* baseUrl) };
                }),
              runEnded: (runId) => deps.store.deleteCallbacks(runId).pipe(Effect.asVoid),
              forget: (automationId) => inbox.setSecret(automationId, null),
              setSecret: (automationId, secret) =>
                inbox.setSecret(automationId, secret).pipe(
                  Effect.andThen(nowIso),
                  Effect.flatMap((now) =>
                    deps.store.setWebhookSecretSet(automationId, secret !== null, now),
                  ),
                ),
            };
          }),
      }),
    );
  }),
);
